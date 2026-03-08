/* ============================================================
   Supabase Edge Function — get-wise-quote  v3.2
   Runtime: Deno (padrão Supabase Edge Functions)

   ⚠️  ERROS NO VS CODE SÃO FALSOS POSITIVOS — veja README abaixo.
   O código funciona 100% ao fazer deploy no Supabase.

   Env var obrigatória (Dashboard → Edge Functions → Secrets):
     WISE_API_TOKEN = Bearer token da Wise API

   Deploy:
     supabase functions deploy get-wise-quote --no-verify-jwt

   Teste local:
     supabase functions serve get-wise-quote --env-file .env.local
   ============================================================ */

// ── CORS headers ─────────────────────────────────────────────────
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Handler principal ─────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {

  // Pre-flight CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    // ── 1. Validar body ───────────────────────────────────────
    const {
      sourceAmount,
      sourceCurrency = "BRL",
      targetCurrency = "PYG",
    } = (await req.json()) as {
      sourceAmount:    number;
      sourceCurrency?: string;
      targetCurrency?: string;
    };

    if (!sourceAmount || sourceAmount <= 0) {
      return json({ error: "sourceAmount deve ser um número positivo" }, 400);
    }

    // ── 2. Ler WISE_API_TOKEN ─────────────────────────────────
    // Deno.env.get() é um global do runtime Deno.
    // O VS Code pode sublinhar em vermelho, mas NÃO é um erro real.
    const WISE_TOKEN = Deno.env.get("WISE_API_TOKEN");
    if (!WISE_TOKEN) {
      throw new Error("WISE_API_TOKEN não configurado nos Secrets da Edge Function.");
    }

    // ── 3. Chamar Wise API v3/quotes ──────────────────────────
    const wiseRes = await fetch("https://api.wise.com/v3/quotes", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${WISE_TOKEN}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ sourceCurrency, targetCurrency, sourceAmount }),
    });

    if (!wiseRes.ok) {
      const errText = await wiseRes.text();
      console.error("[get-wise-quote] Wise error:", wiseRes.status, errText);
      return json({ error: `Wise retornou ${wiseRes.status}: ${errText}` }, wiseRes.status);
    }

    const data = await wiseRes.json();

    // ── 4. Extrair melhor opção de pagamento ──────────────────
    type PayOpt = {
      payIn:         string;
      targetAmount?: number;
      fee?:          { total?: number; transferwise?: number };
    };

    const options: PayOpt[] = data.paymentOptions ?? [];
    const best = options.find((o) => o.payIn === "BANK_TRANSFER") ?? options[0];

    const targetAmount: number = data.targetAmount ?? best?.targetAmount ?? 0;
    const fee: number          = best?.fee?.total ?? best?.fee?.transferwise ?? 0;

    // ── 5. Responder ao frontend ──────────────────────────────
    return json({
      targetAmount,           // ₲ que o destinatário recebe
      fee,                    // R$ cobrado pela Wise
      rate:           data.rate           ?? null,
      expirationTime: data.expirationTime ?? null,
      sourceCurrency,
      targetCurrency,
      sourceAmount,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[get-wise-quote] Unhandled error:", msg);
    return json({ error: msg }, 500);
  }
});