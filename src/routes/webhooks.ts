import { Router, Request, Response } from 'express';
import { stmtInsertWebhook, stmtGetWebhooks, stmtDeleteWebhook, WebhookRow } from '../db';
import { normalizeAddr } from '../services/addressContext';

const router = Router({ mergeParams: true });

// POST /addresses/:address/webhooks
router.post('/', (req: Request, res: Response) => {
  try {
    const address = normalizeAddr(req.params['address'] as string);
    const { url, secret } = req.body as { url?: string; secret?: string };

    if (!url || !/^https?:\/\/.+/.test(url)) {
      res.status(400).json({ error: 'url is required and must be an http(s) URL' });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const result = stmtInsertWebhook.run(address, url, secret || null, now);

    res.status(201).json({ id: result.lastInsertRowid, wallet_addr: address, url, created_at: now });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /addresses/:address/webhooks
router.get('/', (req: Request, res: Response) => {
  try {
    const address = normalizeAddr(req.params['address'] as string);
    const hooks = stmtGetWebhooks.all(address) as WebhookRow[];
    res.json(hooks.map((h) => ({ id: h.id, url: h.url, has_secret: !!h.secret, created_at: h.created_at })));
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /addresses/:address/webhooks/:id
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const address = normalizeAddr(req.params['address'] as string);
    const id = parseInt(req.params['id'] as string, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }

    const result = stmtDeleteWebhook.run(id, address);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    res.json({ deleted: true, id });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
