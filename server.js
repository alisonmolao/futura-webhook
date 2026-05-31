const express = require("express");
const stripe = require("stripe")("sk_test_51TcdO6CDfqTlc3vEtu8WrQsKKmRdgFj5EPEyZTlf6WZfYcKFrtGChG97WwRJd7r1V7P5lyc55bDMsPNW0fAkbIrz00KgkE1lf9");
const admin = require("firebase-admin");
const app = express();

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_ID = "price_1TcdSXCDfqTlc3vErsXoRTDe";
const SUCCESS_URL = "https://frolicking-tanuki-e5e9b3.netlify.app?sucesso=1";
const CANCEL_URL = "https://frolicking-tanuki-e5e9b3.netlify.app?cancelado=1";

app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.get("/", (req, res) => res.send("Futura Impressao Webhook Server OK"));

app.options("/criar-checkout", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.status(204).send("");
});

app.post("/criar-checkout", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const { email, uid } = req.body;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      metadata: { uid },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send("Webhook Error: " + err.message);
  }
  const obj = event.data.object;
  if (event.type === "checkout.session.completed") {
    const uid = obj.metadata.uid;
    await db.collection("usuarios").doc(uid).set({
      assinatura: "ativa",
      stripeCustomerId: obj.customer,
      stripeSubscriptionId: obj.subscription,
      ativadoEm: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  if (event.type === "customer.subscription.deleted" || event.type === "invoice.payment_failed") {
    const snap = await db.collection("usuarios").where("stripeCustomerId", "==", obj.customer).get();
    snap.forEach(async doc => await doc.ref.update({ assinatura: "inativa" }));
  }
  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
