const express = require('express');
const Stripe = require('stripe');
const { google } = require('googleapis');
const Airtable = require('airtable');

const app = express();
const port = process.env.PORT || 3000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const airtable = new Airtable({
  apiKey: process.env.AIRTABLE_API_KEY
}).base('appUNIsu8KgvOlmi0');

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground'
);

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

app.use(express.json());
app.use(express.raw({ type: 'application/json' }));

let logs = [];

function addLog(message) {
  const timestamp = new Date().toISOString();
  logs.push({ timestamp, message });
  console.log(`[${timestamp}] ${message}`);
  if (logs.length > 50) logs = logs.slice(-50);
}

async function sendGmailAlert(paymentData) {
  try {
    const subject = `Payment Failed: ${paymentData.customer_email}`;
    const body = `Payment ID: ${paymentData.payment_id}\nAmount: $${(paymentData.amount/100).toFixed(2)}\nReason: ${paymentData.failure_message}`;

    const message = [
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      `To: ${process.env.ALERT_EMAIL || 'admin@example.com'}`,
      `Subject: ${subject}`,
      '',
      body
    ].join('\n');

    const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage }
    });

    addLog(`Alert sent for ${paymentData.payment_id}`);
  } catch (error) {
    addLog(`Gmail error: ${error.message}`);
  }
}

async function addToAirtable(paymentData) {
  try {
    const table = airtable('Failed Payments');
    const record = await table.create([{
      fields: {
        'Payment ID': paymentData.payment_id,
        'Customer Email': paymentData.customer_email,
        'Amount': paymentData.amount / 100,
        'Currency': paymentData.currency,
        'Failure Code': paymentData.failure_code,
        'Failure Message': paymentData.failure_message,
        'Failed At': paymentData.failed_at,
        'Status': 'New'
      }
    }]);

    addLog(`Added to Airtable: ${record[0].id}`);
  } catch (error) {
    addLog(`Airtable error: ${error.message}`);
  }
}

async function processFailedPayment(event) {
  let paymentData = {};

  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    paymentData = {
      payment_id: pi.id,
      customer_email: pi.receipt_email || 'Unknown',
      amount: pi.amount,
      currency: pi.currency,
      failure_code: pi.last_payment_error?.code || 'unknown',
      failure_message: pi.last_payment_error?.message || 'Payment failed',
      failed_at: new Date(event.created * 1000).toISOString()
    };
  }

  await sendGmailAlert(paymentData);
  await addToAirtable(paymentData);
}

app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.payment_failed') {
    await processFailedPayment(event);
  }

  res.json({ received: true });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Stripe Payment Monitor',
    status: 'running',
    endpoints: {
      'POST /webhook/stripe': 'Stripe webhook',
      'GET /health': 'Health check',
      'POST /test': 'Test run'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.get('/logs', (req, res) => {
  res.json({ logs: logs.slice(-20) });
});

app.post('/test', async (req, res) => {
  try {
    const testData = {
      payment_id: 'test_' + Date.now(),
      customer_email: 'test@example.com',
      amount: 5000,
      currency: 'usd',
      failure_code: 'card_declined',
      failure_message: 'Test failure',
      failed_at: new Date().toISOString()
    };

    await sendGmailAlert(testData);
    await addToAirtable(testData);
    
    res.json({ success: true, testData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  addLog(`Server started on port ${port}`);
});