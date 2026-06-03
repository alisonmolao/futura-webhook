const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const app = express();
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_ID = process.env.STRIPE_PRICE_ID;
const SUCCESS_URL = "https://frolicking-tanuki-e5e9b3.netlify.app?sucesso=1";
const CANCEL_URL = "https://frolicking-tanuki-e5e9b3.netlify.app?cancelado=1";
const TRIAL_DAYS = 7; // dias de teste grátis para NOVOS usuários

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

    // O teste grátis vale só para quem NUNCA assinou/testou antes.
    // Quem já teve uma assinatura tem trialUsado=true e vai direto para a cobrança.
    let jaUsouTrial = false;
    try {
      const snap = await db.collection("usuarios").doc(uid).get();
      jaUsouTrial = snap.exists && snap.data().trialUsado === true;
    } catch (e) {
      // Em caso de erro de leitura, concede o teste — para não cobrar
      // por engano um possível novo usuário (a tela promete "7 dias grátis").
      jaUsouTrial = false;
    }

    const params = {
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
      metadata: { uid },
    };

    // Adiciona os 7 dias grátis apenas para novos usuários.
    // Por padrão o Stripe guarda o cartão durante o teste e faz a 1ª cobrança
    // automaticamente quando o teste acaba (8º dia).
    if (!jaUsouTrial) {
      params.subscription_data = { trial_period_days: TRIAL_DAYS };
    }

    const session = await stripe.checkout.sessions.create(params);
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

  // Checkout concluído: libera acesso (vale também durante o teste grátis)
  // e marca trialUsado para o usuário não ganhar outro teste no futuro.
  if (event.type === "checkout.session.completed") {
    const uid = obj.metadata.uid;
    await db.collection("usuarios").doc(uid).set({
      assinatura: "ativa",
      trialUsado: true,
      stripeCustomerId: obj.customer,
      stripeSubscriptionId: obj.subscription,
      ativadoEm: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  // Assinatura cancelada OU cobrança falhou (ex.: cartão recusado no 8º dia):
  // corta o acesso.
  if (event.type === "customer.subscription.deleted" || event.type === "invoice.payment_failed") {
    const snap = await db.collection("usuarios").where("stripeCustomerId", "==", obj.customer).get();
    snap.forEach(async (doc) => await doc.ref.update({ assinatura: "inativa" }));
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
