require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)); // add this line
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve frontend files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/credentials.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'credentials.html'));
});

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Nodemailer transporter using Gmail
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
});

// API: Initialize Paystack payment
app.post('/api/init-payment', async (req, res) => {
  const { email, planType } = req.body;
  const plan = {
    daily: 4,
    weekly: 25,
    monthly: 100
  }[planType];

  if (!plan) return res.status(400).json({ error: "Invalid plan" });

  res.json({
    key: process.env.PAYSTACK_PUBLIC_KEY,
    email,
    amount: plan * 100,
    reference: 'FLINT-' + Math.floor(Math.random() * 1000000000),
    metadata: { plan_type: planType }
  });
});

// API: Verify payment & fetch WiFi credentials
app.post('/api/verify-payment', async (req, res) => {
  const { reference, email, planType, amount } = req.body;

  try {
    // Verify with Paystack
    const paystackResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );
    const paystackData = await paystackResponse.json();

    if (!paystackData.status) {
      return res.status(400).json({ error: "Payment verification failed" });
    }

    // Fetch credentials from Supabase
    const { data, error } = await supabase.rpc(
      'process_transaction_and_delete_login',
      {
        p_payment_ref: reference,
        p_customer_email: email,
        p_plan_type: planType,
        p_amount: amount
      }
    );

    if (error) throw error;

    // Send email with credentials
    const mailOptions = {
      from: `Flint WiFi <${process.env.EMAIL_FROM}>`,
      to: email,
      subject: 'Your WiFi Credentials',
      html: `
        <h1>Your WiFi Login Details</h1>
        <p>Plan: <strong>${planType}</strong></p>
        <p><strong>Username:</strong> ${data[0].username}</p>
        <p><strong>Password:</strong> ${data[0].password}</p>
        <br>
        <p>Thank you for choosing Flint WiFi!</p>
      `,
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      console.log('✅ Email sent:', info.messageId);
    } catch (emailError) {
      console.error('❌ Failed to send email:', emailError);
      // Still proceed to show credentials
    }

    res.json({
      success: true,
      credentials: data[0],
      redirectUrl: `/credentials.html?username=${encodeURIComponent(data[0].username)}&password=${encodeURIComponent(data[0].password)}`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));