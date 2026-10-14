export default {
  async fetch(request, env, ctx) {
    // ============================================================
    // CORS
    // ============================================================
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

    // ============================================================
    // OPTIONS (CORS preflight)
    // ============================================================
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ============================================================
    // Tik POST
    // ============================================================
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "Method not allowed. Use POST." }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ============================================================
    // RATE LIMITING - 5 užklausos per 1 minutę
    // ============================================================
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();
    
    let rateLimitOk = true;
    let remaining = 0;
    
    try {
      if (env.RATE_LIMIT_KV) {
        // === KV-based rate limiting ===
        const windowSec = 60;
        const maxRequests = 5;
        
        const key = `rl:${clientIp}:${Math.floor(now / 1000 / windowSec)}`;
        const current = await env.RATE_LIMIT_KV.get(key);
        const count = current ? parseInt(current) : 0;
        
        if (count >= maxRequests) {
          rateLimitOk = false;
        } else {
          await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: windowSec + 10 });
          remaining = maxRequests - count - 1;
        }
      } else {
        // === In-memory fallback ===
        if (!globalThis.__rateLimitMap) {
          globalThis.__rateLimitMap = new Map();
        }
        const map = globalThis.__rateLimitMap;
        const windowMs = 60000;
        const maxRequests = 5;
        
        let timestamps = map.get(clientIp) || [];
        timestamps = timestamps.filter(t => now - t < windowMs);
        
        if (timestamps.length >= maxRequests) {
          rateLimitOk = false;
        } else {
          timestamps.push(now);
          map.set(clientIp, timestamps);
          remaining = maxRequests - timestamps.length;
        }
        
        if (map.size > 1000) {
          for (const [ip, times] of map.entries()) {
            const fresh = times.filter(t => now - t < windowMs);
            if (fresh.length === 0) map.delete(ip);
            else map.set(ip, fresh);
          }
        }
      }
    } catch (e) {
      console.error("Rate limit error:", e);
    }
    
    if (!rateLimitOk) {
      return new Response(
        JSON.stringify({ error: "Per daug užklausų. Palaukite 1 minutę." }),
        { 
          status: 429, 
          headers: { 
            ...corsHeaders, 
            "Content-Type": "application/json",
            "Retry-After": "60"
          } 
        }
      );
    }

    // ============================================================
    // Maršrutizavimas
    // ============================================================
    const url = new URL(request.url);
    const path = url.pathname;

    // ============================================================
    // /vision - Google Cloud Vision API (OCR)
    // ============================================================
    if (path === "/vision" || path === "/vision/") {
      if (!env.GOOGLE_VISION_KEY) {
        return new Response(
          JSON.stringify({ 
            error: "Server configuration error: GOOGLE_VISION_KEY missing",
            hint: "Secret not set in Cloudflare Workers Settings",
            fix: "Cloudflare Dashboard → deepl-proxy → Settings → Variables and Secrets → Add Secret named GOOGLE_VISION_KEY"
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      try {
        const body = await request.text();
        
        if (body.length > 10 * 1024 * 1024) {
          return new Response(
            JSON.stringify({ error: "Užklausa per didelė (max 10MB)" }),
            { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        const visionRes = await fetch(
          `https://vision.googleapis.com/v1/images:annotate?key=${env.GOOGLE_VISION_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body
          }
        );

        const responseText = await visionRes.text();
        
        // 🔍 DIAGNOSTIKA: jei Google grąžina klaidą - parodykime TIKRĄ priežastį
        if (!visionRes.ok) {
          let parsedError = null;
          try {
            const parsed = JSON.parse(responseText);
            if (parsed.error) {
              parsedError = {
                code: parsed.error.code,
                message: parsed.error.message,
                status: parsed.error.status
              };
            }
          } catch (e) {
            parsedError = { raw: responseText.substring(0, 500) };
          }
          
          return new Response(
            JSON.stringify({ 
              error: "Google Vision API klaida",
              httpStatus: visionRes.status,
              googleError: parsedError,
              keyPresent: !!env.GOOGLE_VISION_KEY,
              keyPrefix: env.GOOGLE_VISION_KEY ? env.GOOGLE_VISION_KEY.substring(0, 10) + "..." : "MISSING"
            }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        return new Response(responseText, {
          status: visionRes.status,
          headers: { 
            ...corsHeaders, 
            "Content-Type": "application/json",
            "X-RateLimit-Remaining": String(remaining)
          }
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ 
            error: "Vision API nepasiekiama", 
            details: error.message,
            type: error.name
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ============================================================
    // / (root) - DeepL vertimas
    // ============================================================
    if (!env.DEEPL_KEY) {
      return new Response(
        JSON.stringify({ 
          error: "Server configuration error: DEEPL_KEY missing",
          hint: "Secret not set in Cloudflare Workers Settings"
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    try {
      const body = await request.text();
      
      if (body.length > 500 * 1024) {
        return new Response(
          JSON.stringify({ error: "Tekstas per ilgas (max 500KB)" }),
          { status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      const deeplResponse = await fetch("https://api-free.deepl.com/v2/translate", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `DeepL-Auth-Key ${env.DEEPL_KEY}`
        },
        body: body
      });

      const responseText = await deeplResponse.text();
      
      if (!deeplResponse.ok) {
        let parsedError = null;
        try {
          parsedError = JSON.parse(responseText);
        } catch (e) {
          parsedError = { raw: responseText.substring(0, 500) };
        }
        
        return new Response(
          JSON.stringify({ 
            error: "DeepL API klaida",
            httpStatus: deeplResponse.status,
            deeplError: parsedError
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      return new Response(responseText, {
        status: deeplResponse.status,
        headers: { 
          ...corsHeaders, 
          "Content-Type": "application/json",
          "X-RateLimit-Remaining": String(remaining)
        }
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ 
          error: "Vertimo paslauga laikinai nepasiekiama", 
          details: error.message 
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }
};
