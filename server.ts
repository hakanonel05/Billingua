import express from "express";
import path from "path";
import { proxyTranslate } from "./server/translate-proxy";

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

  // Proxy for Google Translate (see server/translate-proxy.ts)
  app.post("/api/process-text", async (req, res) => {
    const { text, targetLang, sourceLang = 'auto' } = req.body;
    if (!text || !targetLang) {
      return res.status(400).json({ error: "Missing text or targetLang" });
    }
    console.log(`[Proxy] Request received for ${text.length} chars, target: ${targetLang}, source: ${sourceLang}`);
    try {
      res.json({ translation: await proxyTranslate(text, targetLang, sourceLang) });
    } catch (err: any) {
      console.error(`[Proxy] All translation methods failed. Last error: ${err?.message}`);
      res.status(500).json({ error: "Translation failed after multiple attempts.", details: err?.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
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
