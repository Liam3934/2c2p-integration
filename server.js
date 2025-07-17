// server.js
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const axios = require("axios");

const cors = require("cors");


const app = express();
const PORT = process.env.PORT || 5000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cors()); 

const {
  MERCHANT_ID,
  SECRET_KEY,
  PAYMENT_URL,
  FRONTEND_RETURN_URL,
  BACKEND_RETURN_URL,
  WEBFLOW_ORDER_API,
  SORASO_WEBHOOK,
} = process.env;

function generatePayloadSignature(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64");
  const signature = crypto.createHmac("sha256", SECRET_KEY).update(payload).digest("hex");
  return { payload, signature };
}

// Start payment
app.post("/api/start-payment", async (req, res) => {
  const {
    amount,
    description,
    customerEmail,
    customerName,
    bookingDate,
    products,
    address
  } = req.body;

  const invoiceNo = "INV" + Date.now();
  const amountStr = parseFloat(amount).toFixed(2).replace(".", "");

  const paymentRequest = {
    version: "8.5",
    merchantID: MERCHANT_ID,
    invoiceNo,
    description: description || "Online Purchase",
    amount: amountStr,
    currencyCode: "764",
    paymentChannel: "ALL",
    frontendReturnUrl: FRONTEND_RETURN_URL,
    backendReturnUrl: BACKEND_RETURN_URL,
    userDefined1: customerEmail,
    userDefined2: JSON.stringify({
      customerName,
      products,
      bookingDate,
      address
    })
  };

  const { payload, signature } = generatePayloadSignature(paymentRequest);

  res.json({
    paymentURL: PAYMENT_URL,
    payload,
    signature
  });
});

// Callback after payment
app.post("/api/payment-callback", async (req, res) => {
  const { payload, signature } = req.body;

  const expectedSignature = crypto.createHmac("sha256", SECRET_KEY).update(payload).digest("hex");
  if (expectedSignature !== signature) return res.status(400).send("Invalid signature");

  const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
  if (decoded.paymentStatus !== "0000") return res.status(200).send("Payment not successful");

  const invoiceNo = decoded.invoiceNo;
  const customerEmail = decoded.userDefined1;
  let extraData = {};
  try {
    extraData = JSON.parse(decoded.userDefined2);
  } catch (e) {}

  const sorasoPayload = {
    TriggerType: "ecomm_order_changed",
    Payload: {
      OrderId: invoiceNo,
      Status: "fulfilled",
      AcceptedOn: new Date().toISOString(),
      FulfilledOn: new Date().toISOString(),
      CustomerPaid: {
        Unit: "THB",
        Value: (parseFloat(decoded.amount) / 100).toString(),
        String: `${parseFloat(decoded.amount) / 100} THB`
      },
      NetAmount: {
        Unit: "THB",
        Value: (parseFloat(decoded.amount) / 100).toString(),
        String: `${parseFloat(decoded.amount) / 100} THB`
      },
      ApplicationFee: {
        Unit: "THB",
        Value: "0",
        String: "0 THB"
      },
      CustomerInfo: {
        FullName: extraData.customerName || "Unknown",
        Email: customerEmail
      },
      BillingAddress: extraData.address || {},
      ShippingAddress: extraData.address || {},
      AllAddresses: [extraData.address || {}],
      PurchasedItems: (extraData.products || "1x Unknown").split(',').map(p => ({
        Count: 1,
        ProductName: p.trim(),
        VariantPrice: {
          Unit: "THB",
          Value: "0",
          String: "0 THB"
        },
        RowTotal: {
          Unit: "THB",
          Value: "0",
          String: "0 THB"
        },
        VariantImage: { Url: "" },
        ProductId: "",
        VariantId: "",
        VariantSKU: null,
        VariantSlug: "",
        ProductSlug: "",
        VariantName: "",
        Weight: 0,
        Width: 0,
        Height: 0,
        Length: 0
      })),
      PurchasedItemsCount: (extraData.products || "").split(',').length,
      Metadata: {
        IsBuyNow: true,
        AppointmentDate: extraData.bookingDate || null
      },
      Totals: {
        Subtotal: {
          Unit: "THB",
          Value: (parseFloat(decoded.amount) / 100).toString(),
          String: `${parseFloat(decoded.amount) / 100} THB`
        },
        Extras: [],
        Total: {
          Unit: "THB",
          Value: (parseFloat(decoded.amount) / 100).toString(),
          String: `${parseFloat(decoded.amount) / 100} THB`
        }
      },
      PaymentProcessor: "2C2P",
      StripeDetails: {},
      StripeCard: {},
      CustomData: [],
      IsCustomerDeleted: false,
      IsShippingRequired: false,
      HasDownloads: false,
      DownloadFiles: []
    }
  };

  try {
    await axios.post(SORASO_WEBHOOK, sorasoPayload);
    console.log("✅ Soraso ticket created");
  } catch (err) {
    console.error("❌ Soraso Error:", err.response?.data || err.message);
  }

  res.status(200).send("ACK");
});

app.get("/", (_, res) => res.send("2C2P Integration Server is Live ✅"));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
