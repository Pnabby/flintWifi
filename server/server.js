require('dotenv').config({path:'../.env'});
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const app = express();
const path = require('path');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/credentials.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'credentials.html'));
});
 // Serve frontend files

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const transporter = nodemailer.createTransport({
  host: 'smtp.sendgrid.net',
  port: 587,
  secure: false, // TLS
  auth: {
    user: 'apikey', // Literal string 'apikey'
    pass: process.env.SENDGRID_API_KEY, // Your SendGrid API key
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
    key: process.env.PAYSTACK_PUBLIC_KEY, // Frontend uses this to initialize Paystack
    email,
    //amount: plan * 100,
    amount: 0.1 * 100,
    reference: 'FLINT-' + Math.floor(Math.random() * 1000000000),
    metadata: { plan_type: planType }
  });
});

// API: Verify payment & fetch WiFi credentials
app.post('/api/verify-payment', async (req, res) => {
  const { reference, email, planType, amount } = req.body;

  try {
    // Verify with Paystack (server-side)
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

    // Fetch WiFi credentials from Supabase
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

    // Send email via Nodemailer
    // const mailOptions = {
    //   from: `Flint WiFi <${process.env.EMAIL_FROM}>`, // Sender address
    //   to: email, // Recipient
    //   subject: 'Your WiFi Credentials', // Email subject
    //   html: `
    //     <h1>Your WiFi Login Details</h1>
    //     <p>Plan: ${planType}</p>
    //     <p><strong>Username:</strong> ${data[0].username}</p>
    //     <p><strong>Password:</strong> ${data[0].password}</p>
    //     <p>Thank you for choosing Flint WiFi!</p>
    //   `,
    // };

    // try {
    //   await transporter.sendMail(mailOptions);
    //   console.log('Email sent successfully');
    // } catch (error) {
    //   console.log(error)
    // }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));