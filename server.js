require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const axios = require("axios");

const app = express();
app.use(cors({ origin: "*" }));
app.use(bodyParser.json());

const {
  MERCHANT_ID,
  SECRET_KEY,
  CURRENCY_CODE,
  FRONTEND_RETURN_URL,
  BACKEND_RETURN_URL,
  WEBFLOW_API_TOKEN,
  COLLECTION_ID,
  SORASO_WEBHOOK
} = process.env;

function generateJWT(payload) {
  return jwt.sign(payload, SECRET_KEY, {
    algorithm: "HS256",
    header: {
      alg: "HS256",
      typ: "JWT"
    }
  });
}

app.post("/api/start-payment", async (req, res) => {
  const { amount, description, customerEmail, products, bookingDate } = req.body;

  const invoiceNo = "INV" + Date.now();
  const amountFormatted = parseFloat(amount).toFixed(2);
  const safeEmail = (customerEmail || "guest@example.com").substring(0, 100);
  const safeProducts = (products || "N/A").substring(0, 200).replace(/[^\x00-\x7F]/g, '');
  const safeDate = bookingDate || null;

  const paymentPayload = {
    merchantID: MERCHANT_ID,
    invoiceNo,
    description: description || "Aquaverse Ticket",
    amount: parseFloat(amountFormatted),
    currencyCode: CURRENCY_CODE,
    paymentChannel: ["CC"],
    frontendReturnUrl: FRONTEND_RETURN_URL,
    backendReturnUrl: BACKEND_RETURN_URL,
    userDefined1: safeEmail,
    userDefined2: safeProducts,
    userDefined3: safeDate
  };

  const jwtToken = generateJWT(paymentPayload);

  try {
    const response = await axios.post(
      "https://sandbox-pgw.2c2p.com/payment/4.3/paymentToken",
      { payload: jwtToken },
      { headers: { "Content-Type": "application/json" } }
    );

    const decoded = jwt.verify(response.data.payload, SECRET_KEY, { algorithms: ["HS256"] });

    if (decoded.respCode !== "0000") {
      return res.status(400).json({ error: "Token generation failed", ...decoded });
    }

    return res.json({ redirectUrl: decoded.webPaymentUrl });
  } catch (err) {
    console.error("❌ Token API Error:", err.response?.data || err.message);
    res.status(500).send("Failed to generate payment token.");
  }
});

app.post("/api/payment-callback", async (req, res) => {
  const { payload } = req.body;

  try {
    const decoded = jwt.verify(payload, SECRET_KEY, {
      algorithms: ["HS256"]
    });

    if (decoded.respCode === "0000") {
      const webflowData = {
        orderNumber: decoded.invoiceNo,
        status: "Paid",
        customer: decoded.userDefined1,
        total: decoded.amount,
        products: decoded.userDefined2
      };

      try {
        await axios.post("https://int-production.up.railway.app/api/webflow-order", webflowData);
      } catch (err) {
        console.error("❌ Webflow Order Error:", err.response?.data || err.message);
      }

      try {
        const sorasoPayload = {
          TriggerType: "ecomm_order_changed",
          Payload: {
            OrderId: decoded.invoiceNo,
            Status: "fulfilled",
            Comment: "",
            OrderComment: "",
            AcceptedOn: new Date().toISOString(),
            FulfilledOn: new Date().toISOString(),
            RefundedOn: null,
            DisputedOn: null,
            DisputeUpdatedOn: null,
            DisputeLastStatus: null,
            CustomerPaid: {
              Unit: CURRENCY_CODE,
              Value: decoded.amount.toString(),
              String: `${decoded.amount} ${CURRENCY_CODE}`
            },
            NetAmount: {
              Unit: CURRENCY_CODE,
              Value: decoded.amount.toString(),
              String: `${decoded.amount} ${CURRENCY_CODE}`
            },
            ApplicationFee: {
              Unit: CURRENCY_CODE,
              Value: "0",
              String: null
            },
            AllAddresses: [],
            ShippingAddress: null,
            BillingAddress: null,
            ShippingProvider: null,
            ShippingTracking: null,
            ShippingTrackingURL: null,
            CustomerInfo: {
              FullName: decoded.userDefined1.split('@')[0],
              Email: decoded.userDefined1
            },
           PurchasedItems: decoded.userDefined2.split(',').map(item => {
  const [qtyText, ...nameParts] = item.trim().split('x ');
  const count = parseInt(qtyText.trim()) || 1;
  const productName = nameParts.join('x ').trim() || "Unknown";

  return {
    Count: count,
    ProductName: productName,
    ProductId: "",
    VariantId: "",
    ProductSlug: "",
    VariantSlug: "",
    VariantName: "",
    VariantSKU: null,
    VariantImage: { Url: "" },
    VariantPrice: {
      Unit: CURRENCY_CODE,
      Value: "0",
      String: `0 ${CURRENCY_CODE}`
    },
    RowTotal: {
      Unit: CURRENCY_CODE,
      Value: "0",
      String: `0 ${CURRENCY_CODE}`
    },
    Weight: 0, Width: 0, Height: 0, Length: 0
  };
}),

            PurchasedItemsCount: decoded.userDefined2.split(',').length,
            StripeDetails: {},
            StripeCard: {},
            CustomData: [],
            Metadata: {
              IsBuyNow: true,
              AppointmentDate: decoded.userDefined3 || null
            },
            IsCustomerDeleted: false,
            IsShippingRequired: false,
            HasDownloads: false,
            PaymentProcessor: "2C2P",
            Totals: {
              Subtotal: {
                Unit: CURRENCY_CODE,
                Value: decoded.amount.toString(),
                String: `${decoded.amount} ${CURRENCY_CODE}`
              },
              Extras: [],
              Total: {
                Unit: CURRENCY_CODE,
                Value: decoded.amount.toString(),
                String: `${decoded.amount} ${CURRENCY_CODE}`
              }
            },
            DownloadFiles: []
          }
        };

        console.log("🔍 Final Soraso Payload:", JSON.stringify(sorasoPayload, null, 2));

        await axios.post(SORASO_WEBHOOK, sorasoPayload);
      } catch (err) {
        console.error("❌ Soraso Error:", err.response?.data || err.message);
      }
    }
  } catch (err) {
    console.error("❌ Invalid JWT:", err.message);
    return res.status(400).send("Invalid signature");
  }

  res.status(200).send("ACK");
});

app.post("/api/webflow-order", async (req, res) => {
  const { orderNumber, status, customer, total, products } = req.body;

  if (!orderNumber || !customer || !total) {
    return res.status(400).json({ error: "Missing required order fields" });
  }

  const fieldData = {
    name: `Order ${orderNumber}`,
    slug: orderNumber.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    "order-number": orderNumber,
    "customer-email": customer,
    total: parseFloat(total),
    "status-2": status,
    product: products,
    _archived: false,
    _draft: false
  };

  try {
    const response = await axios.post(
      `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items?live=true`,
      { fieldData },
      {
        headers: {
          Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.status(200).json({
      success: true,
      message: "Webflow order created",
      data: response.data
    });
  } catch (err) {
    console.error("❌ Webflow API Error:", err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
      details: err.response?.data || null
    });
  }
});

app.get("/", (_, res) => {
  res.send("🚀 2C2P Payment Server Running");
});

app.get("/api/dev/generate-jwt", (req, res) => {
  const invoiceNo = "INV" + Date.now();
  const payload = {
    merchantID: MERCHANT_ID,
    invoiceNo,
    description: "Test Product",
    amount: 1000.00,
    currencyCode: CURRENCY_CODE
  };

  const token = generateJWT(payload);

  res.json({
    jwtToken: token,
    rawPayload: payload
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
