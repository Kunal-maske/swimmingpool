require("dotenv").config();
const express = require("express");
const multer = require("multer");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const Razorpay = require("razorpay");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

// Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_test_1DP5MMOk92gagR",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "test_mode",
});

// Check if using mock mode (test credentials)
const isMockMode =
  process.env.RAZORPAY_KEY_SECRET === "test_mode" ||
  !process.env.RAZORPAY_KEY_SECRET ||
  process.env.RAZORPAY_KEY_SECRET.includes("your_actual");
if (isMockMode) {
  console.log(
    "⚠️  MOCK MODE: Using test orders (Razorpay credentials not configured)",
  );
  console.log("📝 To use real payments, update RAZORPAY_KEY_SECRET in .env");
}

// Middleware
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static("public"));

// Create uploads directory if it doesn't exist
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// Multer configuration for photo uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Token required" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
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

// Register
app.post("/api/register", upload.single("photo"), async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    const photoPath = req.file ? `/uploads/${req.file.filename}` : null;

    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ error: "Name, email, and password are required" });
    }

    // Check if user already exists
    const existing = await db.get("SELECT id FROM Users WHERE email = ?", [
      email,
    ]);
    if (existing) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const result = await db.run(
      "INSERT INTO Users (name, email, password_hash, phone, photo_path, role) VALUES (?, ?, ?, ?, ?, ?)",
      [name, email, hashedPassword, phone, photoPath, "member"],
    );

    const user = await db.get(
      "SELECT id, name, email, role FROM Users WHERE id = ?",
      [result.lastID],
    );

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
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await db.get(
      "SELECT id, name, email, password_hash, role FROM Users WHERE email = ?",
      [email],
    );

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
      expiresIn: "30d",
    });

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
  upload.single("photo"),
  async (req, res) => {
    try {
      const { name, date_of_birth } = req.body;
      const photoPath = req.file ? `/uploads/${req.file.filename}` : null;
      const userId = req.user.id;

      if (!name || !date_of_birth) {
        return res
          .status(400)
          .json({ error: "Name and date of birth are required" });
      }

      const result = await db.run(
        "INSERT INTO FamilyMembers (user_id, name, date_of_birth, photo_path) VALUES (?, ?, ?, ?)",
        [userId, name, date_of_birth, photoPath],
      );

      const member = await db.get(
        "SELECT id, name, date_of_birth, photo_path FROM FamilyMembers WHERE id = ?",
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
      "SELECT id, name, date_of_birth, photo_path FROM FamilyMembers WHERE user_id = ?",
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
      "SELECT id, name, child_price, adult_price, senior_price, duration_days FROM Plans",
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
    keyId: process.env.RAZORPAY_KEY_ID || "rzp_test_1DP5MMOk92gagR",
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
      "SELECT name, date_of_birth, user_id FROM FamilyMembers WHERE id = ?",
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
      "SELECT id, name, child_price, adult_price, senior_price, duration_days FROM Plans WHERE id = ?",
      [plan_id],
    );

    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    // Calculate age and price
    const dob = new Date(member.date_of_birth);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const hasBirthday =
      today.getMonth() > dob.getMonth() ||
      (today.getMonth() === dob.getMonth() && today.getDate() >= dob.getDate());
    if (!hasBirthday) age--;

    let price;
    if (age < 12) price = plan.child_price;
    else if (age >= 60) price = plan.senior_price;
    else price = plan.adult_price;

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
      console.error("Razorpay Error:", paymentErr.message);
      return res
        .status(500)
        .json({
          error: `Payment gateway error: ${paymentErr.message}. Make sure RAZORPAY_KEY_SECRET is set in .env`,
        });
    }

    res.json({
      orderId: order.id,
      amount: price,
      currency: "INR",
      memberName: member.name,
      planName: plan.name,
      age,
      durationDays: plan.duration_days,
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
      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
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
      "SELECT user_id FROM FamilyMembers WHERE id = ?",
      [family_member_id],
    );
    const plan = await db.get("SELECT duration_days FROM Plans WHERE id = ?", [
      plan_id,
    ]);

    if (!member || !plan || member.user_id !== req.user.id) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Create subscription
    const startDate = new Date().toISOString().split("T")[0];
    const endDate = new Date(
      Date.now() + plan.duration_days * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .split("T")[0];

    const subscription = await db.run(
      "INSERT INTO Subscriptions (family_member_id, plan_id, start_date, end_date, payment_id, status) VALUES (?, ?, ?, ?, ?, ?)",
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
      "INSERT INTO QRCodes (subscription_id, token, expires_at, is_valid) VALUES (?, ?, ?, ?)",
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
        p.name as plan_name
      FROM QRCodes q
      JOIN Subscriptions s ON q.subscription_id = s.id
      JOIN FamilyMembers fm ON s.family_member_id = fm.id
      JOIN Plans p ON s.plan_id = p.id
      WHERE fm.user_id = ? AND s.status = 'active'
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

// Get all registered users (admin only)
app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const users = await db.all(`
      SELECT 
        u.id,
        u.name,
        u.email,
        u.phone,
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
        fm.date_of_birth,
        fm.photo_path,
        u.id as user_id,
        u.name as user_name,
        u.email,
        s.id as subscription_id,
        p.id as plan_id,
        p.name as plan_name,
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

      // Calculate age
      const result = data.map((item) => {
        const dob = new Date(item.date_of_birth);
        const today = new Date();
        let age = today.getFullYear() - dob.getFullYear();
        const hasBirthday =
          today.getMonth() > dob.getMonth() ||
          (today.getMonth() === dob.getMonth() &&
            today.getDate() >= dob.getDate());
        if (!hasBirthday) age--;

        return {
          ...item,
          age,
        };
      });

      res.json(result);
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
        fm.date_of_birth,
        p.name as plan_name
      FROM QRCodes q
      JOIN Subscriptions s ON q.subscription_id = s.id
      JOIN FamilyMembers fm ON s.family_member_id = fm.id
      JOIN Plans p ON s.plan_id = p.id
      WHERE q.token = ?
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
      await db.run("UPDATE QRCodes SET is_valid = 0 WHERE id = ?", [qr.id]);

      return res.json({
        valid: false,
        reason: "QR code expired or invalid",
      });
    }

    // Calculate age
    const dob = new Date(qr.date_of_birth);
    const todayDate = new Date();
    let age = todayDate.getFullYear() - dob.getFullYear();
    const hasBirthday =
      todayDate.getMonth() > dob.getMonth() ||
      (todayDate.getMonth() === dob.getMonth() &&
        todayDate.getDate() >= dob.getDate());
    if (!hasBirthday) age--;

    res.json({
      valid: true,
      member: {
        name: qr.member_name,
        photo_path: qr.photo_path,
        age,
        date_of_birth: qr.date_of_birth,
        plan: qr.plan_name,
        expires_at: qr.expires_at,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Validation failed" });
  }
});

// ============ SERVER ============

app.listen(PORT, () => {
  console.log(
    `\n🏊 Swimming Pool Management System running on http://localhost:${PORT}`,
  );
  console.log(`\n📱 Admin credentials:`);
  console.log(`   Email: admin@pool.com`);
  console.log(`   Password: admin123\n`);
});
