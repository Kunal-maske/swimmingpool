require("dotenv").config();
const express = require("express");
const multer = require("multer");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const Razorpay = require("razorpay");
const {
  calculateAge,
  escapeCsvCell,
  isAddableMemberType,
  isEligibleForPlan,
  isPlanForAccount,
} = require("./public/utils");

const JWT_SECRET = process.env.JWT_SECRET?.trim();
if (
  !JWT_SECRET ||
  Buffer.byteLength(JWT_SECRET, "utf8") < 32 ||
  /change_this|your_|replace_me/i.test(JWT_SECRET)
) {
  throw new Error("Set JWT_SECRET to a unique random value of at least 32 bytes");
}

const db = require("./database");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const uploadsDirectory = path.resolve(
  process.env.UPLOAD_DIR || path.join(__dirname, "uploads"),
);
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) {
  throw new Error("TRUST_PROXY_HOPS must be a non-negative integer");
}
if (trustProxyHops > 0) {
  app.set("trust proxy", trustProxyHops);
}
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  crypto.randomBytes(48).toString("hex"),
  12,
);

const razorpayKeyId = process.env.RAZORPAY_KEY_ID?.trim();
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET?.trim();

const hasValidRazorpayConfig =
  Boolean(razorpayKeyId) &&
  Boolean(razorpayKeySecret) &&
  !razorpayKeyId.includes("your_razorpay") &&
  !razorpayKeySecret.includes("your_razorpay") &&
  !razorpayKeySecret.includes("your_actual") &&
  razorpayKeySecret !== "test_mode";

const isMockMode = !hasValidRazorpayConfig;

if (isProduction && isMockMode && process.env.ENABLE_MOCK_PAYMENTS !== "true") {
  throw new Error(
    "Production requires valid Razorpay credentials. Set ENABLE_MOCK_PAYMENTS=true only for a deliberate non-production deployment.",
  );
}

const razorpay = hasValidRazorpayConfig
  ? new Razorpay({
      key_id: razorpayKeyId,
      key_secret: razorpayKeySecret,
    })
  : null;

if (isMockMode) {
  console.log(
    "⚠️  MOCK MODE: Razorpay credentials are missing or still using placeholders. Test orders will be used instead.",
  );
}

// Middleware
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://checkout.razorpay.com", "https://unpkg.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://api.razorpay.com"],
      frameSrc: ["'self'", "https://api.razorpay.com", "https://checkout.razorpay.com"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "100kb", extended: false }));
app.use(express.static(path.join(__dirname, "public"), { dotfiles: "deny" }));
app.use(
  "/uploads",
  express.static(uploadsDirectory, { dotfiles: "deny", index: false }),
);

app.get("/healthz", (req, res) => res.json({ status: "ok" }));
app.get("/readyz", async (req, res) => {
  try {
    await db.ready;
    await db.get("SELECT 1");
    res.json({ status: "ready" });
  } catch (error) {
    console.error("Readiness check failed:", error);
    res.status(503).json({ status: "not ready" });
  }
});

// Create uploads directory if it doesn't exist
fs.mkdirSync(uploadsDirectory, { recursive: true, mode: 0o750 });

// Multer configuration for photo uploads
const allowedImageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!allowedImageTypes.has(file.mimetype)) {
      callback(new Error("Unsupported image type"));
      return;
    }
    callback(null, true);
  },
});

const receivePhoto = (req, res, next) => {
  upload.single("photo")(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        error: "Upload a JPEG, PNG, or WebP image no larger than 5 MB",
      });
    }
    next();
  });
};

const storeVerifiedPhoto = async (req, res, next) => {
  if (!req.file) return next();

  try {
    const { fileTypeFromBuffer } = await import("file-type");
    const detectedType = await fileTypeFromBuffer(req.file.buffer);
    if (!detectedType || !allowedImageTypes.has(detectedType.mime)) {
      return res.status(400).json({
        error: "Upload a valid JPEG, PNG, or WebP image",
      });
    }

    const filename = `${crypto.randomUUID()}.${detectedType.ext}`;
    await fs.promises.writeFile(
      path.join(uploadsDirectory, filename),
      req.file.buffer,
      { flag: "wx", mode: 0o640 },
    );
    req.file.filename = filename;
    next();
  } catch (error) {
    console.error("Photo storage failed:", error);
    res.status(500).json({ error: "Photo upload failed" });
  }
};

// Middleware to verify JWT token
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Token required" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await db.get(
      "SELECT id, role, account_type FROM Users WHERE id = $1",
      [decoded.id],
    );
    if (!user || user.role === "disabled") {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// Middleware to verify admin role
const verifyAdmin = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};

// ============ AUTHENTICATION ROUTES ============

const registerAccount = (accountType) => async (req, res) => {
  try {
    const { password, confirmPassword, phone, employee_id } = req.body;
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const dateOfBirth = req.body.date_of_birth;
    const age = calculateAge(dateOfBirth);
    const employeeId = accountType === "faculty" && typeof employee_id === "string"
      ? employee_id.trim()
      : null;
    const photoPath = req.file ? `/uploads/${req.file.filename}` : null;

    if (
      !name ||
      !email ||
      !password ||
      !confirmPassword ||
      !phone ||
      !dateOfBirth ||
      (accountType === "faculty" && !employeeId)
    ) {
      return res
        .status(400)
        .json({ error: "All required registration fields must be provided" });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: "Password must be between 8 and 128 characters" });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }

    if (age === null || age > 120) {
      return res.status(400).json({ error: "Enter a valid date of birth" });
    }

    const existing = await db.get("SELECT id FROM Users WHERE email = $1", [
      email,
    ]);
    if (existing) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const user = await db.transaction(async (client) => {
      const result = await client.query(
        "INSERT INTO Users (name, email, password_hash, phone, date_of_birth, employee_id, account_type, photo_path, role) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, name, email, date_of_birth, employee_id, account_type, role",
        [
          name,
          email,
          hashedPassword,
          phone,
          dateOfBirth,
          employeeId,
          accountType,
          photoPath,
          "member",
        ],
      );
      const newUser = result.rows[0];

      await client.query(
        "INSERT INTO Members (user_id, name, date_of_birth, member_type, photo_path) VALUES ($1, $2, $3, $4, $5)",
        [
          newUser.id,
          newUser.name,
          newUser.date_of_birth,
          accountType === "outside" ? "outside" : "employee",
          photoPath,
        ],
      );

      return newUser;
    });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({ message: "User registered successfully", user, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
};

app.post(
  "/api/register",
  receivePhoto,
  storeVerifiedPhoto,
  registerAccount("faculty"),
);
app.post(
  "/api/register/outside",
  receivePhoto,
  storeVerifiedPhoto,
  registerAccount("outside"),
);

// Login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
});

app.post("/api/login", loginLimiter, async (req, res) => {
  try {
    const email = typeof req.body.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
    const { password } = req.body;

    if (!email || typeof password !== "string" || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await db.get(
      "SELECT id, name, email, password_hash, role, account_type FROM Users WHERE LOWER(email) = $1",
      [email],
    );
    const passwordMatches = await bcrypt.compare(
      password,
      user?.password_hash || DUMMY_PASSWORD_HASH,
    );

    if (!user || user.role === "disabled" || !passwordMatches) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: user.role === "admin" ? "1h" : "30d" },
    );

    res.json({
      message: "Login successful",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        account_type: user.account_type,
      },
      token,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ============ MEMBER ROUTES ============

// Add a family member or guest
app.post(
  "/api/members",
  verifyToken,
  receivePhoto,
  storeVerifiedPhoto,
  async (req, res) => {
    try {
      const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
      const dateOfBirth = req.body.date_of_birth;
      const memberType = req.body.member_type;
      const age = calculateAge(dateOfBirth);
      const photoPath = req.file ? `/uploads/${req.file.filename}` : null;
      const userId = req.user.id;

      if (!name || age === null || age > 120 || !isAddableMemberType(memberType)) {
        return res
          .status(400)
          .json({ error: "Enter a name, valid date of birth, and member type (family or guest)" });
      }

      const result = await db.run(
        "INSERT INTO Members (user_id, name, date_of_birth, member_type, photo_path) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [userId, name, dateOfBirth, memberType, photoPath],
      );

      const member = await db.get(
        "SELECT id, name, date_of_birth, member_type, photo_path FROM Members WHERE id = $1",
        [result.lastID],
      );

      res.json({ message: "Member added successfully", member });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to add member" });
    }
  },
);

// Get my employees, family members, and guests
app.get("/api/members", verifyToken, async (req, res) => {
  try {
    const members = await db.all(
      "SELECT id, name, date_of_birth, member_type, photo_path FROM Members WHERE user_id = $1 ORDER BY CASE member_type WHEN 'employee' THEN 0 WHEN 'family' THEN 1 ELSE 2 END, name",
      [req.user.id],
    );

    res.json(members);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch members" });
  }
});

// ============ PLANS ROUTE ============

// Get all plans
app.get("/api/plans", async (req, res) => {
  try {
    const plans = await db.all(
      "SELECT id, duration_days, age_min, age_max, duration_type, price, audience FROM Plans WHERE is_active = 1 ORDER BY audience, duration_days, age_min, id",
    );
    res.json(plans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch plans" });
  }
});

app.get("/api/my-plans", verifyToken, async (req, res) => {
  try {
    const plans = await db.all(
      "SELECT id, duration_days, age_min, age_max, duration_type, price, audience FROM Plans WHERE is_active = 1 AND audience = $1 ORDER BY duration_days, age_min, id",
      [req.user.account_type],
    );
    res.json(plans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch plans" });
  }
});

// Get Razorpay Key
app.get("/api/razorpay-key", (req, res) => {
  res.json({
    keyId: razorpayKeyId || null,
  });
});

// ============ PAYMENT & SUBSCRIPTION ROUTES ============

// Create Razorpay order
app.post("/api/create-order", verifyToken, async (req, res) => {
  try {
    const { member_id, plan_id } = req.body;

    if (!member_id || !plan_id) {
      return res
        .status(400)
        .json({ error: "Member and plan are required" });
    }

    // Get selected member
    const member = await db.get(
      "SELECT name, date_of_birth, member_type, user_id FROM Members WHERE id = $1",
      [member_id],
    );

    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    if (member.user_id !== req.user.id) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Get plan
    const plan = await db.get(
      "SELECT id, duration_days, age_min, age_max, duration_type, price, audience FROM Plans WHERE id = $1 AND is_active = 1",
      [plan_id],
    );

    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    if (!isPlanForAccount(plan, req.user.account_type)) {
      return res.status(403).json({ error: "This plan is not available for your account type" });
    }

    if (!isEligibleForPlan(member.date_of_birth, plan)) {
      return res.status(400).json({
        error: `This plan is available for ages ${plan.age_min}${plan.age_max === null ? "+" : `-${plan.age_max}`} only`,
      });
    }
    const price = plan.price;

    // Create Razorpay order
    let order;
    try {
      if (isMockMode) {
        // Mock order for testing without real Razorpay credentials
        order = {
          id: `order_${Math.random().toString(36).substr(2, 9)}`,
          amount: Math.round(price * 100),
          currency: "INR",
          status: "created",
        };
        console.log("Mock order created:", order.id);
      } else {
        if (!razorpay) {
          return res.status(500).json({
            error:
              "Razorpay is not configured. Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.",
          });
        }

        // Real Razorpay order
        order = await razorpay.orders.create({
          amount: Math.round(price * 100), // Razorpay expects amount in paise
          currency: "INR",
          receipt: `order_${Date.now()}`,
          notes: {
            member_id,
            member_type: member.member_type,
            plan_id,
            user_id: req.user.id,
          },
        });
        console.log("Real Razorpay order created:", order.id);
      }
    } catch (paymentErr) {
      const paymentMessage =
        paymentErr?.error?.description ||
        paymentErr?.message ||
        "Unknown Razorpay error";

      console.error("Razorpay Error:", paymentMessage);
      return res.status(500).json({
        error: `Payment gateway error: ${paymentMessage}`,
      });
    }

    await db.run(
      "INSERT INTO PaymentOrders (order_id, user_id, member_id, plan_id, amount) VALUES ($1, $2, $3, $4, $5)",
      [order.id, req.user.id, member_id, plan_id, Number(price)],
    );

    res.json({
      orderId: order.id,
      amount: price,
      currency: "INR",
      memberName: member.name,
      memberType: member.member_type,
      durationDays: plan.duration_days,
      durationType: plan.duration_type,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Order creation failed" });
  }
});

// Verify payment and create subscription
app.post("/api/verify-payment", verifyToken, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      member_id,
      plan_id,
    } = req.body;

    if (!razorpay_order_id || !member_id || !plan_id) {
      return res.status(400).json({ error: "Payment order, member, and plan are required" });
    }

    const paymentOrder = await db.get(
      "SELECT id, user_id, member_id, plan_id, amount, status FROM PaymentOrders WHERE order_id = $1",
      [razorpay_order_id],
    );
    if (!paymentOrder || paymentOrder.user_id !== req.user.id ||
        paymentOrder.member_id !== Number(member_id) ||
        paymentOrder.plan_id !== Number(plan_id) || paymentOrder.status !== "created") {
      return res.status(400).json({ error: "Invalid or already processed payment order" });
    }

    // Verify signature (skip only in explicitly permitted mock mode)
    if (!isMockMode) {
      if (!razorpayKeySecret || !razorpay_payment_id || !razorpay_signature) {
        return res.status(500).json({
          error: "Razorpay secret is missing. Set RAZORPAY_KEY_SECRET in .env.",
        });
      }

      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac("sha256", razorpayKeySecret)
        .update(body)
        .digest("hex");

      const expected = Buffer.from(expectedSignature, "utf8");
      const received = Buffer.from(razorpay_signature, "utf8");
      if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
        return res.status(400).json({ error: "Payment verification failed" });
      }
    } else {
      console.log("Mock mode: Skipping signature verification");
    }

    // Get selected member and plan
    const member = await db.get(
      "SELECT user_id, date_of_birth, member_type FROM Members WHERE id = $1",
      [member_id],
    );
    const plan = await db.get(
      "SELECT duration_days, age_min, age_max, is_active, price, audience FROM Plans WHERE id = $1",
      [plan_id],
    );

    if (!member || !plan || !plan.is_active || member.user_id !== req.user.id) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (!isPlanForAccount(plan, req.user.account_type)) {
      return res.status(403).json({ error: "This plan is not available for your account type" });
    }

    if (Number(paymentOrder.amount) !== Number(plan.price)) {
      return res.status(400).json({ error: "Payment amount no longer matches the selected plan" });
    }

    if (!isEligibleForPlan(member.date_of_birth, plan)) {
      return res.status(400).json({ error: "Member is not eligible for this plan" });
    }

    // Create subscription
    const startDate = new Date().toISOString().split("T")[0];
    const endDate = new Date(
      Date.now() + plan.duration_days * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .split("T")[0];

    const paymentId = razorpay_payment_id || `mock_${Date.now()}`;
    const subscription = await db.transaction(async (client) => {
      const inserted = await client.query(
        "INSERT INTO Subscriptions (member_id, plan_id, start_date, end_date, payment_id, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [member_id, plan_id, startDate, endDate, paymentId, "active"],
      );
      await client.query(
        "UPDATE PaymentOrders SET status = 'paid', payment_id = $1 WHERE id = $2",
        [paymentId, paymentOrder.id],
      );
      return { lastID: inserted.rows[0].id };
    });

    // Generate QR code token
    const qrToken = uuidv4();
    const expiresAt = endDate;

    await db.run(
      "INSERT INTO QRCodes (subscription_id, token, expires_at, is_valid) VALUES ($1, $2, $3, $4)",
      [subscription.lastID, qrToken, expiresAt, 1],
    );

    // Generate QR code image
    const qrDataUrl = await QRCode.toDataURL(qrToken, {
      errorCorrectionLevel: "L",
      type: "image/png",
      width: 300,
    });

    res.json({
      message: "Payment verified and subscription created",
      subscription: {
        id: subscription.lastID,
        startDate,
        endDate,
      },
      qrCode: qrDataUrl,
      qrToken,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Payment verification failed" });
  }
});

// Get my QR codes
app.get("/api/my-qrcodes", verifyToken, async (req, res) => {
  try {
    const qrcodes = await db.all(
      `
      SELECT 
        q.id,
        q.token,
        q.expires_at,
        q.is_valid,
        s.start_date,
        s.end_date,
        m.name as member_name,
        m.member_type,
        m.photo_path,
        p.age_min,
        p.age_max,
        p.duration_type,
        p.duration_days
      FROM QRCodes q
      JOIN Subscriptions s ON q.subscription_id = s.id
      JOIN Members m ON s.member_id = m.id
      JOIN Plans p ON s.plan_id = p.id
      WHERE m.user_id = $1 AND s.status = 'active'
      ORDER BY q.created_at DESC
    `,
      [req.user.id],
    );

    // Generate QR images
    const qrCodesWithImages = await Promise.all(
      qrcodes.map((qr) => {
        return QRCode.toDataURL(qr.token, {
          errorCorrectionLevel: "L",
          type: "image/png",
          width: 200,
        }).then((qrDataUrl) => ({ ...qr, qrImage: qrDataUrl }));
      }),
    );

    res.json(qrCodesWithImages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch QR codes" });
  }
});

// ============ ADMIN ROUTES ============

app.get("/api/admin/plans", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const plans = await db.all(
      "SELECT id, duration_days, age_min, age_max, duration_type, price, audience, is_active FROM Plans ORDER BY audience, duration_days, age_min, id",
    );
    res.json(plans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch plans" });
  }
});

app.post("/api/admin/plans", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { age_min, age_max, duration_type, price, audience } = req.body;
    const minimumAge = Number(age_min);
    const maximumAge = age_max === "" || age_max === null ? null : Number(age_max);
    const planPrice = Number(price);
    const durationDays = { daily: 1, monthly: 30, annual: 365 }[duration_type];

    if (
      !Number.isInteger(minimumAge) ||
      minimumAge < 0 ||
      (maximumAge !== null &&
        (!Number.isInteger(maximumAge) || maximumAge < minimumAge)) ||
      !durationDays ||
      !Number.isFinite(planPrice) ||
      planPrice <= 0 ||
      !["faculty", "outside"].includes(audience)
    ) {
      return res.status(400).json({ error: "Enter a valid audience, age range, term, and price" });
    }

    const result = await db.run(
      "INSERT INTO Plans (duration_days, age_min, age_max, duration_type, price, audience) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [
        durationDays,
        minimumAge,
        maximumAge,
        duration_type,
        planPrice,
        audience,
      ],
    );
    const plan = await db.get(
      "SELECT id, age_min, age_max, duration_type, duration_days, price, audience FROM Plans WHERE id = $1",
      [result.lastID],
    );
    res.status(201).json(plan);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create plan" });
  }
});

// Get all registered users (admin only)
app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await db.all(`
      SELECT 
        u.id,
        u.name,
        u.email,
        u.phone,
        u.date_of_birth,
        u.employee_id,
        u.account_type,
        u.photo_path,
        u.role,
        u.created_at,
        COUNT(DISTINCT m.id) FILTER (WHERE m.member_type = 'family') as family_count,
        COUNT(DISTINCT m.id) FILTER (WHERE m.member_type = 'guest') as guest_count,
        COUNT(DISTINCT s.id) as subscription_count
      FROM Users u
      LEFT JOIN Members m ON u.id = m.user_id
      LEFT JOIN Subscriptions s ON m.id = s.member_id AND s.status = 'active'
      WHERE u.role = 'member'
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);

    res.json(users);
  } catch (err) {
    console.error(err);
      res.status(500).json({ error: "Failed to fetch users" });
  }
});

// Get all members with subscriptions (admin only)
app.get(
  "/api/admin/members-subscriptions",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const data = await db.all(`
      SELECT 
        m.id,
        m.name as member_name,
        m.date_of_birth,
        m.member_type,
        m.photo_path,
        u.id as user_id,
        u.name as user_name,
        u.email,
        u.account_type,
        s.id as subscription_id,
        p.id as plan_id,
        p.age_min,
        p.age_max,
        p.duration_type,
        s.start_date,
        s.end_date as expires_at,
        s.status
      FROM Subscriptions s
      INNER JOIN Members m ON s.member_id = m.id
      INNER JOIN Users u ON m.user_id = u.id
      INNER JOIN Plans p ON s.plan_id = p.id
      WHERE s.status = 'active'
      ORDER BY s.start_date DESC
    `);

      res.json(data);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch members" });
    }
  },
);

app.get("/api/admin/subscriptions/export", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const subscriptions = await db.all(`
      SELECT
        s.id AS subscription_id,
        m.name AS member_name,
        m.member_type,
        m.date_of_birth,
        u.name AS account_name,
        u.email AS account_email,
        u.employee_id,
        u.account_type,
        p.id AS plan_id,
        p.audience AS plan_audience,
        p.duration_type,
        p.duration_days,
        p.age_min,
        p.age_max,
        p.price AS plan_price,
        CASE WHEN po.status = 'paid' THEN po.amount END AS paid_amount,
        COALESCE(po.status, 'not found') AS payment_status,
        COALESCE(s.payment_id, '') AS payment_id,
        s.start_date,
        s.end_date,
        s.status AS subscription_status,
        to_char(
          s.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) AS subscription_created_at
      FROM Subscriptions s
      INNER JOIN Members m ON s.member_id = m.id
      INNER JOIN Users u ON m.user_id = u.id
      INNER JOIN Plans p ON s.plan_id = p.id
      LEFT JOIN PaymentOrders po ON po.payment_id = s.payment_id
      ORDER BY s.created_at DESC, s.id DESC
    `);

    const headers = [
      "Subscription ID",
      "Member Name",
      "Member Type",
      "Date of Birth",
      "Account Name",
      "Account Email",
      "Employee ID",
      "Account Type",
      "Plan ID",
      "Plan Audience",
      "Plan Duration",
      "Plan Duration Days",
      "Minimum Eligible Age",
      "Maximum Eligible Age",
      "Plan Price (INR)",
      "Paid Amount (INR)",
      "Payment Status",
      "Payment ID",
      "Start Date",
      "End Date",
      "Subscription Status",
      "Subscription Created At",
    ];
    const rows = subscriptions.map((subscription) => [
      subscription.subscription_id,
      subscription.member_name,
      subscription.member_type,
      subscription.date_of_birth,
      subscription.account_name,
      subscription.account_email,
      subscription.employee_id,
      subscription.account_type,
      subscription.plan_id,
      subscription.plan_audience,
      subscription.duration_type,
      subscription.duration_days,
      subscription.age_min,
      subscription.age_max,
      subscription.plan_price,
      subscription.paid_amount,
      subscription.payment_status,
      subscription.payment_id,
      subscription.start_date,
      subscription.end_date,
      subscription.subscription_status,
      subscription.subscription_created_at,
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map(escapeCsvCell).join(","))
      .join("\r\n");

    res
      .set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="subscriptions-revenue.csv"',
        "Cache-Control": "no-store",
      })
      .send(`\uFEFF${csv}`);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to export subscriptions" });
  }
});

// Validate QR code (admin)
app.post("/api/qr/validate", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: "QR token required" });
    }

    const qr = await db.get(
      `
      SELECT 
        q.id,
        q.is_valid,
        q.expires_at,
        s.id as subscription_id,
        m.name as member_name,
        m.member_type,
        m.photo_path,
        m.date_of_birth,
        p.age_min,
        p.age_max,
        p.duration_type
      FROM QRCodes q
      JOIN Subscriptions s ON q.subscription_id = s.id
      JOIN Members m ON s.member_id = m.id
      JOIN Plans p ON s.plan_id = p.id
      WHERE q.token = $1
    `,
      [token],
    );

    if (!qr) {
      return res.json({
        valid: false,
        reason: "Invalid QR code",
      });
    }

    const today = new Date().toISOString().split("T")[0];

    if (!qr.is_valid || today > qr.expires_at) {
      // Mark as invalid
      await db.run("UPDATE QRCodes SET is_valid = 0 WHERE id = $1", [qr.id]);

      return res.json({
        valid: false,
        reason: "QR code expired or invalid",
      });
    }

    res.json({
      valid: true,
      member: {
        name: qr.member_name,
        member_type: qr.member_type,
        photo_path: qr.photo_path,
        date_of_birth: qr.date_of_birth,
        plan_age_min: qr.age_min,
        plan_age_max: qr.age_max,
        plan_duration_type: qr.duration_type,
        expires_at: qr.expires_at,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Validation failed" });
  }
});

// ============ SERVER ============

let server;

const shutdown = async (signal) => {
  console.log(`${signal} received; shutting down`);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await db.close();
};

process.once("SIGTERM", () => shutdown("SIGTERM").finally(() => process.exit(0)));
process.once("SIGINT", () => shutdown("SIGINT").finally(() => process.exit(0)));

db.ready
  .then(() => {
    server = app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `\n🏊 Swimming Pool Management System running on http://localhost:${PORT}`,
      );
    });
    server.on("error", async (error) => {
      console.error(`Server failed to listen on port ${PORT}: ${error.message}`);
      await shutdown("listen error");
      process.exitCode = 1;
    });
  })
  .catch(async (error) => {
    console.error("PostgreSQL initialization failed:", error);
    await db.close();
    process.exitCode = 1;
  });
