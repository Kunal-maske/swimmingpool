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
const PORT = process.env.PORT || 3000;
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
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "100kb", extended: false }));
app.use(express.static(path.join(__dirname, "public"), { dotfiles: "deny" }));
app.use(
  "/uploads",
  express.static(uploadsDirectory, { dotfiles: "deny", index: false }),
);

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
    const user = await db.get("SELECT id, role FROM Users WHERE id = $1", [
      decoded.id,
    ]);
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

const isEligibleForPlan = (age, plan) =>
  age >= plan.age_min && (plan.age_max === null || age <= plan.age_max);

// ============ AUTHENTICATION ROUTES ============

// Register
app.post("/api/register", receivePhoto, storeVerifiedPhoto, async (req, res) => {
  try {
    const { name, email, password, confirmPassword, phone, employee_id } = req.body;
    const ageInput = req.body.age;
    const age = Number(ageInput);
    const employeeId = typeof employee_id === "string" ? employee_id.trim() : "";
    const photoPath = req.file ? `/uploads/${req.file.filename}` : null;

    if (
      !name ||
      !email ||
      !password ||
      !confirmPassword ||
      !phone ||
      ageInput === undefined ||
      ageInput === "" ||
      !employeeId
    ) {
      return res
        .status(400)
        .json({ error: "All registration fields are required" });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    if (!Number.isInteger(age) || age < 0 || age > 120) {
      return res.status(400).json({ error: "Enter a valid age" });
    }

    // Check if user already exists
    const existing = await db.get("SELECT id FROM Users WHERE email = $1", [
      email,
    ]);
    if (existing) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const user = await db.transaction(async (client) => {
      const result = await client.query(
        "INSERT INTO Users (name, email, password_hash, phone, age, employee_id, photo_path, role) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, email, age, employee_id, role",
        [name, email, hashedPassword, phone, age, employeeId, photoPath, "member"],
      );
      const newUser = result.rows[0];

      await client.query(
        "INSERT INTO FamilyMembers (user_id, name, age, photo_path) VALUES ($1, $2, $3, $4)",
        [newUser.id, newUser.name, newUser.age, photoPath],
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
});

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
      "SELECT id, name, email, password_hash, role FROM Users WHERE LOWER(email) = $1",
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
      },
      token,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// ============ FAMILY MEMBERS ROUTES ============

// Add family member
app.post(
  "/api/family-members",
  verifyToken,
  receivePhoto,
  storeVerifiedPhoto,
  async (req, res) => {
    try {
      const { name } = req.body;
      const age = Number(req.body.age);
      const photoPath = req.file ? `/uploads/${req.file.filename}` : null;
      const userId = req.user.id;

      if (!name || req.body.age === undefined || req.body.age === "" || !Number.isInteger(age) || age < 0 || age > 120) {
        return res
          .status(400)
          .json({ error: "Name and a valid age are required" });
      }

      const result = await db.run(
        "INSERT INTO FamilyMembers (user_id, name, age, photo_path) VALUES ($1, $2, $3, $4) RETURNING id",
        [userId, name, age, photoPath],
      );

      const member = await db.get(
        "SELECT id, name, age, photo_path FROM FamilyMembers WHERE id = $1",
        [result.lastID],
      );

      res.json({ message: "Family member added successfully", member });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to add family member" });
    }
  },
);

// Get my family members
app.get("/api/family-members", verifyToken, async (req, res) => {
  try {
    const members = await db.all(
      "SELECT id, name, age, photo_path FROM FamilyMembers WHERE user_id = $1",
      [req.user.id],
    );

    res.json(members);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch family members" });
  }
});

// ============ PLANS ROUTE ============

// Get all plans
app.get("/api/plans", async (req, res) => {
  try {
    const plans = await db.all(
      "SELECT id, duration_days, age_min, age_max, duration_type, price FROM Plans WHERE is_active = 1 ORDER BY duration_days, age_min, id",
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
    const { family_member_id, plan_id } = req.body;

    if (!family_member_id || !plan_id) {
      return res
        .status(400)
        .json({ error: "Family member and plan are required" });
    }

    // Get family member
    const member = await db.get(
      "SELECT name, age, user_id FROM FamilyMembers WHERE id = $1",
      [family_member_id],
    );

    if (!member) {
      return res.status(404).json({ error: "Family member not found" });
    }

    if (member.user_id !== req.user.id) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Get plan
    const plan = await db.get(
      "SELECT id, duration_days, age_min, age_max, duration_type, price FROM Plans WHERE id = $1",
      [plan_id],
    );

    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    const age = member.age;
    if (!isEligibleForPlan(age, plan)) {
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
            family_member_id,
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

    res.json({
      orderId: order.id,
      amount: price,
      currency: "INR",
      memberName: member.name,
      age,
      durationDays: plan.duration_days,
      durationType: plan.duration_type,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Order creation failed: ${err.message}` });
  }
});

// Verify payment and create subscription
app.post("/api/verify-payment", verifyToken, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      family_member_id,
      plan_id,
    } = req.body;

    // Verify signature (skip in mock mode)
    if (!isMockMode) {
      if (!razorpayKeySecret) {
        return res.status(500).json({
          error: "Razorpay secret is missing. Set RAZORPAY_KEY_SECRET in .env.",
        });
      }

      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac("sha256", razorpayKeySecret)
        .update(body)
        .digest("hex");

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: "Payment verification failed" });
      }
    } else {
      console.log("Mock mode: Skipping signature verification");
    }

    // Get family member and plan
    const member = await db.get(
      "SELECT user_id, age FROM FamilyMembers WHERE id = $1",
      [family_member_id],
    );
    const plan = await db.get(
      "SELECT duration_days, age_min, age_max FROM Plans WHERE id = $1",
      [plan_id],
    );

    if (!member || !plan || member.user_id !== req.user.id) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (!isEligibleForPlan(member.age, plan)) {
      return res.status(400).json({ error: "Member is not eligible for this plan" });
    }

    // Create subscription
    const startDate = new Date().toISOString().split("T")[0];
    const endDate = new Date(
      Date.now() + plan.duration_days * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .split("T")[0];

    const subscription = await db.run(
      "INSERT INTO Subscriptions (family_member_id, plan_id, start_date, end_date, payment_id, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [
        family_member_id,
        plan_id,
        startDate,
        endDate,
        razorpay_payment_id || `mock_${Date.now()}`,
        "active",
      ],
    );

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
    res
      .status(500)
      .json({ error: `Payment verification failed: ${err.message}` });
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
        fm.name as member_name,
        fm.photo_path,
        p.age_min,
        p.age_max,
        p.duration_type,
        p.duration_days
      FROM QRCodes q
      JOIN Subscriptions s ON q.subscription_id = s.id
      JOIN FamilyMembers fm ON s.family_member_id = fm.id
      JOIN Plans p ON s.plan_id = p.id
      WHERE fm.user_id = $1 AND s.status = 'active'
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

app.post("/api/admin/plans", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { age_min, age_max, duration_type, price } = req.body;
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
      planPrice <= 0
    ) {
      return res.status(400).json({ error: "Enter a valid age range, term, and price" });
    }

    const result = await db.run(
      "INSERT INTO Plans (duration_days, age_min, age_max, duration_type, price) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [
        durationDays,
        minimumAge,
        maximumAge,
        duration_type,
        planPrice,
      ],
    );
    const plan = await db.get(
      "SELECT id, age_min, age_max, duration_type, duration_days, price FROM Plans WHERE id = $1",
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
        u.age,
        u.employee_id,
        u.photo_path,
        u.role,
        u.created_at,
        COUNT(DISTINCT fm.id) as family_count,
        COUNT(DISTINCT s.id) as subscription_count
      FROM Users u
      LEFT JOIN FamilyMembers fm ON u.id = fm.user_id
      LEFT JOIN Subscriptions s ON fm.id = s.family_member_id AND s.status = 'active'
      WHERE u.role = 'member'
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);

    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: `Failed to fetch users: ${err.message}` });
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
        fm.id,
        fm.name as member_name,
        fm.age,
        fm.photo_path,
        u.id as user_id,
        u.name as user_name,
        u.email,
        s.id as subscription_id,
        p.id as plan_id,
        p.age_min,
        p.age_max,
        p.duration_type,
        s.start_date,
        s.end_date as expires_at,
        s.status
      FROM Subscriptions s
      INNER JOIN FamilyMembers fm ON s.family_member_id = fm.id
      INNER JOIN Users u ON fm.user_id = u.id
      INNER JOIN Plans p ON s.plan_id = p.id
      WHERE s.status = 'active'
      ORDER BY s.start_date DESC
    `);

      res.json(data);
    } catch (err) {
      console.error(err);
      res
        .status(500)
        .json({ error: `Failed to fetch members: ${err.message}` });
    }
  },
);

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
        fm.name as member_name,
        fm.photo_path,
        fm.age,
        p.age_min,
        p.age_max,
        p.duration_type
      FROM QRCodes q
      JOIN Subscriptions s ON q.subscription_id = s.id
      JOIN FamilyMembers fm ON s.family_member_id = fm.id
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
        photo_path: qr.photo_path,
        age: qr.age,
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

db.ready
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(
        `\n🏊 Swimming Pool Management System running on http://localhost:${PORT}`,
      );
    });
    server.on("error", async (error) => {
      console.error(`Server failed to listen on port ${PORT}: ${error.message}`);
      await db.close();
      process.exitCode = 1;
    });
  })
  .catch(async (error) => {
    console.error("PostgreSQL initialization failed:", error);
    await db.close();
    process.exitCode = 1;
  });
