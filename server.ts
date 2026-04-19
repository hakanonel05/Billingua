import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // API routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Proxy for Google Translate using a multi-layered robust approach
  app.post("/api/process-text", async (req, res) => {
    try {
      const { text, targetLang, sourceLang = 'auto' } = req.body;
      
      if (!text || !targetLang) {
        return res.status(400).json({ error: "Missing text or targetLang" });
      }

      console.log(`[Proxy] Request received for ${text.length} chars, target: ${targetLang}, source: ${sourceLang}`);

      // Method 1: Google Translate API (Free/Unbalanced endpoint)
      const tryGtxPost = async (t: string, retryCount = 0): Promise<string> => {
        // Try different clients
        const clients = ['gtx', 't', 'at', 'dict-chrome-ex'];
        const client = clients[retryCount % clients.length];
        const url = `https://translate.googleapis.com/translate_a/single?client=${client}&sl=${sourceLang}&tl=${targetLang}&dt=t&ie=UTF-8&oe=UTF-8`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Referer': 'https://translate.google.com/'
            },
            body: `q=${encodeURIComponent(t)}`,
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);

          if ((response.status === 429 || response.status === 503) && retryCount < 3) {
            const delay = 1000 * (retryCount + 1);
            console.warn(`GTX POST ${client} failed (${response.status}). Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return tryGtxPost(t, retryCount + 1);
          }

          if (!response.ok) throw new Error(`GTX POST ${client} returned ${response.status}`);
          
          const data = await response.json();
          let translated = '';
          if (data && data[0]) {
            data[0].forEach((s: any) => { if (s[0]) translated += s[0]; });
          }
          return translated;
        } catch (e: any) {
          clearTimeout(timeoutId);
          if (retryCount < 3) return tryGtxPost(t, retryCount + 1);
          throw e;
        }
      };

      // Method 2: RPC-like endpoint
      const tryGtxRpc = async (t: string): Promise<string> => {
        const url = `https://translate.google.com/translate_a/t?client=webapp&sl=${sourceLang}&tl=${targetLang}&v=1.0&source=bh&tk=1&q=${encodeURIComponent(t)}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        try {
          const response = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Referer': 'https://translate.google.com/'
            },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          if (!response.ok) throw new Error(`GTX RPC returned ${response.status}`);
          const data = await response.json();
          if (Array.isArray(data)) return data.join('');
          return data;
        } catch (e: any) {
          clearTimeout(timeoutId);
          throw e;
        }
      };

      // Method 3: Standard GTX via GET
      const tryGtxGet = async (t: string): Promise<string> => {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(t)}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        try {
          const response = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);
          if (!response.ok) throw new Error(`GTX GET returned ${response.status}`);
          const data = await response.json();
          let translated = '';
          if (data && data[0]) {
            data[0].forEach((s: any) => { if (s[0]) translated += s[0]; });
          }
          return translated;
        } catch (e: any) {
          clearTimeout(timeoutId);
          throw e;
        }
      };

      // Method 4: BatchExecute (Official Web UI endpoint)
      const tryBatchExecute = async (t: string): Promise<string> => {
        const url = 'https://translate.google.com/_/TranslateWebserverUi/data/batchexecute';
        const innerData = JSON.stringify([[t, sourceLang, targetLang, true], [null]]);
        const freq = JSON.stringify([[["MkEWBc", innerData, null, "generic"]]]);
        const body = `f.req=${encodeURIComponent(freq)}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            },
            body,
            signal: controller.signal
          });

          clearTimeout(timeoutId);
          if (!response.ok) throw new Error(`BatchExecute returned ${response.status}`);

          const rawText = await response.text();
          console.log(`[Proxy] BatchExecute rawText length: ${rawText.length}, start: ${rawText.substring(0, 50)}`);
        
        // More robust parsing for BatchExecute
        try {
          // Look for the specific data block in the response
          const jsonStart = rawText.indexOf('\n[[');
          if (jsonStart !== -1) {
            const envelope = JSON.parse(rawText.substring(jsonStart));
            const dataStr = envelope[0][2];
            const data = JSON.parse(dataStr);
            
            // The structure is deeply nested: data[1][0][0][5] or data[1][0][0][0]
            if (data && data[1] && data[1][0] && data[1][0][0]) {
              const result = data[1][0][0];
              if (Array.isArray(result[5])) {
                return result[5].map((s: any) => s[0]).join('');
              }
              return result[0];
            }
          }
          
          // Fallback to regex if JSON parsing fails
          const match = rawText.match(/\[\["wM3Wdb","\[\\"(.*?)\\"/);
          if (match && match[1]) {
            return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          }
          
          const match2 = rawText.match(/\[\["MkEWBc","\[\\"(.*?)\\"/);
          if (match2 && match2[1]) {
            return match2[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          }
        } catch (e) {
          console.error("BatchExecute parsing error:", e);
        }
        
        throw new Error("Could not parse BatchExecute response");
      } catch (e: any) {
        clearTimeout(timeoutId);
        throw e;
      }
    };

      // Try methods in sequence
      try {
        console.log(`[Proxy] Attempting GTX POST for ${text.substring(0, 50)}...`);
        const result = await tryGtxPost(text);
        if (result) {
          console.log(`[Proxy] GTX POST success`);
          return res.json({ translation: result });
        }
        throw new Error("Empty result from GTX POST");
      } catch (err1: any) {
        console.warn(`[Proxy] GTX POST failed: ${err1.message}. Trying GTX RPC...`);
        try {
          const result = await tryGtxRpc(text);
          if (result) {
            console.log(`[Proxy] GTX RPC success`);
            return res.json({ translation: result });
          }
          throw new Error("Empty result from GTX RPC");
        } catch (errRpc: any) {
          console.warn(`[Proxy] GTX RPC failed: ${errRpc.message}. Trying GTX GET...`);
          try {
            const result = await tryGtxGet(text);
            if (result) {
              console.log(`[Proxy] GTX GET success`);
              return res.json({ translation: result });
            }
            throw new Error("Empty result from GTX GET");
          } catch (err3: any) {
            console.warn(`[Proxy] GTX GET failed: ${err3.message}. Trying BatchExecute...`);
            try {
              const result = await tryBatchExecute(text);
              if (result) {
                console.log(`[Proxy] BatchExecute success`);
                return res.json({ translation: result });
              }
              throw new Error("Empty result from BatchExecute");
            } catch (err4: any) {
              console.error(`[Proxy] All translation methods failed. Last error: ${err4.message}`);
              res.status(500).json({ 
                error: "Translation failed after multiple attempts.",
                details: err4.message
              });
            }
          }
        }
      }
    } catch (error: any) {
      console.error("Translation proxy error:", error);
      res.status(500).json({ error: error.message || "Translation failed" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
