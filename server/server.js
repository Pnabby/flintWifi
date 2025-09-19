require('dotenv').config(/*{path:'../.env'}*/);
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

// API: Get available plans
app.get('/api/plans', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('Plans')
      .select('plan_type, amount, description, enabled') 
      .order('amount', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// API: Initialize Paystack payment
app.post('/api/init-payment', async (req, res) => {
  const { email, planType } = req.body;

  try {
    const { data: plan, error } = await supabase
      .from('Plans')
      .select('plan_type, amount, enabled')
      .eq('plan_type', planType)
      .single();

    if (error) return res.status(400).json({ error: "Database error" });
    if (!plan)  return res.status(400).json({ error: "Plan not found" });

    if (plan.enabled === false) {
      return res.status(403).json({ error: "This plan is currently disabled" });
    }

    const reference = `${planType}-${Math.floor(Math.random() * 1e9)}`;

    res.json({
      key: process.env.PAYSTACK_PUBLIC_KEY,
      email,
      amount: plan.amount * 100,
      reference,
      metadata: { plan_type: planType, custom_reference: reference },

      subaccount: process.env.PARTNER_SUBACCOUNT_CODE,
      bearer: "all",   // 👈 split fees proportionally
      transaction_charge: 0

    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "Failed to initialize payment" });
  }
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
    const { data: credentials, error: processError } = await supabase.rpc(
      'process_transaction_and_delete_login',
      {
        p_payment_ref: reference,
        p_customer_email: email,
        p_plan_type: planType,
        p_amount: amount
      }
    );

    if (processError) throw processError;

    // Send email with credentials
    const mailOptions = {
      from: `Flint WiFi <${process.env.EMAIL_FROM}>`,
      to: email,
      subject: 'Your WiFi Credentials',
      html: `
        <h1>Your WiFi Login Details</h1>
        <p>Plan: <strong>${planType}</strong></p>
        <p><strong>Username:</strong> ${credentials[0].username}</p>
        <p><strong>Password:</strong> ${credentials[0].password}</p>
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
      credentials: credentials[0],
      redirectUrl: `/credentials.html?username=${encodeURIComponent(credentials[0].username)}&password=${encodeURIComponent(credentials[0].password)}`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post('/api/manual-verify', async (req, res) => {
  const { email } = req.body;

  try {
    // Step 1: Fetch Paystack customer by email
    const customerResponse = await fetch(
      `https://api.paystack.co/customer/${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const customerData = await customerResponse.json();

    if (!customerData.status || !customerData.data) {
      console.log('Customer not found on Paystack');
      return res.status(404).json({ error: "Customer not found on Paystack" });
    }

    const customerId = customerData.data.id;

    // Step 2: Fetch last 5 transactions for this customer
    const txResponse = await fetch(
      `https://api.paystack.co/transaction?customer=${customerId}&perPage=3`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const txData = await txResponse.json();

    if (!txData.status || !txData.data || txData.data.length === 0) {
      console.log("No transactions found for this customer");
      return res.status(404).json({ error: "No transactions found for this customer" });
    }

    // Calculate date 2 days ago
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    // Step 3: Check each transaction (newest first)
    for (const transaction of txData.data) {
      // Skip non-successful transactions
      if (transaction.status !== 'success') continue;

      // Parse transaction date and check if it's within 2 days
      const transactionDate = new Date(transaction.paid_at || transaction.created_at);
      if (transactionDate < twoDaysAgo) {
        console.log(`Skipping transaction ${transaction.reference} - older than 2 days`);
        continue;
      }

      // Check if this transaction exists in our database
      const { data: existingTx, error: txError } = await supabase
        .from('Transactions')
        .select('*')
        .eq('payment_reference', transaction.reference)
        .maybeSingle();

      if (txError) throw txError;

      // If transaction is already in our DB, skip to next one
      if (existingTx) continue;

      // If we get here, we found a valid transaction to process
      const planType = transaction.reference.split('-')[0];
      const amount = transaction.amount / 100;

      const { data: credentials, error: processError } = await supabase.rpc(
        'process_transaction_and_delete_login',
        {
          p_payment_ref: transaction.reference,
          p_customer_email: email,
          p_plan_type: planType,
          p_amount: amount
        }
      );

      if (processError) throw processError;

      // Send email with credentials
      const mailOptions = {
        from: `Flint WiFi <${process.env.EMAIL_FROM}>`,
        to: email,
        subject: 'Your WiFi Credentials',
        html: `
          <h1>Your WiFi Login Details</h1>
          <p>Plan: <strong>${planType}</strong></p>
          <p><strong>Username:</strong> ${credentials[0].username}</p>
          <p><strong>Password:</strong> ${credentials[0].password}</p>
          <br>
          <p>Thank you for choosing Flint WiFi!</p>
        `,
      };

      try {
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Email sent:', info.messageId);
      } catch (emailError) {
        console.error('❌ Failed to send email:', emailError);
      }

      return res.json({
        status: 'processed',
        credentials: credentials?.[0],
        reference: transaction.reference,
        message: "Payment processed successfully"
      });
    }

    // If we checked all transactions and didn't find any valid ones
    // Check if any recent processed transactions exist
    const { data: recentProcessedTx, error: recentTxError } = await supabase
      .from('Transactions')
      .select('payment_reference, created_at')
      .eq('customer_email', email)
      .gte('created_at', twoDaysAgo.toISOString())
      .limit(1);

    if (recentTxError) throw recentTxError;

    if (recentProcessedTx && recentProcessedTx.length > 0) {
      return res.json({
        status: 'exists',
        message: "Your recent payment was already processed",
        reference: recentProcessedTx[0].payment_reference
      });
    }

    // No valid transactions found
    res.json({
      status: 'unprocessed',
      message: "No successful unprocessed payments found in the last 2 days",
      reference: null
    });

  } catch (err) {
    console.error('Manual verification error:', err);
    res.status(500).json({ error: "Manual verification failed" });
  }
});


// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
