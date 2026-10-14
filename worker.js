export default {
  async fetch(request, env, ctx) {
    // ===== CORS =====
    const ALLOWED_ORIGINS = [
      "https://ej3.eu",
      "https://www.ej3.eu",
      "https://todzi-diy.github.io"
    ];
    
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };

    // ===== OPTIONS (CORS preflight) =====
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ===== Tik POST =====
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed. Use POST." }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ============================================================
    // /vision - Google Cloud Vision API (OCR)
    // ============================================================
    if (path === "/vision" || path === "/vision/") {
      if (!env.GOOGLE_VISION_KEY) {
        return new Response(
          JSON.stringify({ error: "Server configuration error: GOOGLE_VISION_KEY missing" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      try {
        const body = await request.text();
        const visionRes = await fetch(
          `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body
          }
        );

        const responseText = await visionRes.text();
        return new Response(responseText, {
          status: visionRes.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: "Vision API nepasiekiama", details: error.message }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ============================================================
    // / (root) - DeepL vertimas
    // ============================================================
    if (!env.DEEPL_KEY) {
      return new Response(
        JSON.stringify({ error: "Server configuration error: DEEPL_KEY missing" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    try {
      const body = await request.text();
      const deeplResponse = await fetch("https://api-free.deepl.com/v2/translate", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `DeepL-Auth-Key ${env.DEEPL_KEY}`
        },
        body: body
      });

      const responseText = await deeplResponse.text();
      return new Response(responseText, {
        status: deeplResponse.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: "Vertimo paslauga laikinai nepasiekiama", details: error.message }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }
};
