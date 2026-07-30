# Hosting Ashu Codex AI for free

Oracle Cloud **Always Free** is the only genuinely free option that gives a
real always-on server with enough memory: 4 Ampere ARM cores, 24 GB RAM,
200 GB disk, 10 TB/month egress. Not a trial — free indefinitely.

**Set expectations first: this will not be faster than your laptop.** Inference
is CPU-bound either way; 4 Ampere cores land roughly where 8 Intel cores do.
What you gain is a machine that is always on and reachable from anywhere.
Speed needs a GPU, and free always-on GPUs do not exist.

---

## What it needs

| | |
|---|---|
| RAM | 8 GB minimum — the model alone sits at 5.5 GB resident |
| Disk | ~10 GB (qwen2.5-coder 4.7 GB + nomic-embed 0.3 GB + app) |
| CPU | 4+ **dedicated** cores, not burstable |
| The app itself | 400 KB backend + 276 KB built frontend |

Oracle's free tier gives 24 GB and 200 GB, so there is plenty of headroom —
enough to add the vision model (another 6 GB) later.

---

## 1. Create the instance

In the Oracle Cloud console: **Compute → Instances → Create**.

- **Shape:** `VM.Standard.A1.Flex` — Ampere ARM, this is the free one
- **OCPUs:** 4 · **Memory:** 24 GB
- **Image:** Ubuntu 24.04
- Save the SSH key it offers. There is no recovering it later.

> **The one real annoyance.** Free ARM capacity is often exhausted in popular
> regions, and you get `Out of host capacity`. Retry at different hours, or
> pick a less busy region when you create the account — the home region cannot
> be changed afterwards.

Then **Networking → Virtual Cloud Network → Security List** and open inbound
**80** and **443** only.

Never open **5000** (the backend) or **11434** (Ollama). Ollama has no
authentication whatsoever — an open port there means anyone can run your
models, and read anything the assistant can read.

---

## 2. Run the setup

```bash
ssh -i your-key.pem ubuntu@<server-ip>
git clone https://github.com/aniltiwari22/AI_PROJECT.git
bash AI_PROJECT/deploy/setup.sh
```

It installs Node 20, Ollama, and the app; pins Ollama to loopback with
`OLLAMA_MAX_LOADED_MODELS=1`; pulls both models; builds the frontend; and
generates a fresh password.

**Write that password down when it prints.** It is shown once and stored only
as a scrypt hash. Do not reuse the laptop's password.

Budget 20–30 minutes, mostly model download.

---

## 3. Point a domain at it

You need a hostname for HTTPS. A free subdomain from DuckDNS or FreeDNS is
fine, or any domain you own — an `A` record to the server's IP.

Then in `~/AI_PROJECT/.env`:

```
CORS_ORIGIN=https://your.domain
TRUST_PROXY=1
```

`TRUST_PROXY` is not optional behind Caddy. Without it every request looks like
it came from the proxy, so the login lockout counts everybody's attempts into
one bucket and locks the whole world out after ten wrong guesses.

---

## 4. Start it

```bash
sudo apt install -y caddy
sudo cp ~/AI_PROJECT/deploy/ashu-backend.service /etc/systemd/system/
sudo systemctl enable --now ashu-backend

# Replace your.domain in the Caddyfile first.
sudo cp ~/AI_PROJECT/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy fetches a Let's Encrypt certificate on its own. Open
`https://your.domain` and sign in.

```bash
journalctl -u ashu-backend -f     # follow the backend
curl https://your.domain/ping     # liveness, needs no session
```

---

## 5. Moving your existing data

On the laptop, take a consistent snapshot — do not copy `ashu.db` while the
backend is running, because recent writes are still in the write-ahead log:

```bash
cd backend
node -e "const D=require('better-sqlite3');const d=new D('../storage/ashu.db',{readonly:true});d.exec(\"VACUUM INTO '../storage/snapshot.db'\");d.close()"
```

Then copy `snapshot.db` to the server as `storage/ashu.db`, and copy
`storage/knowledge.xlsx` across too. Do **not** copy `.env` — the server has
its own password.

---

## What changes once it is hosted

| | |
|---|---|
| **Repository indexing** | Reads the *server's* disk, not your laptop. Your local projects are no longer reachable. Set `REPO_ALLOWED_ROOTS` to whatever you clone onto the server. |
| **Voice** | Unaffected — recognition and speech both run in the browser. |
| **File uploads** | Unaffected. |
| **Telegram** | Move `TELEGRAM_ALLOWED_CHAT_IDS` across, and run the bot on the server only — two instances polling the same token fight over updates. |
| **Speed** | Roughly the same. Do not expect an improvement. |

That first row is the real cost of hosting, and it is worth weighing: repository
indexing is the feature that makes this useful on your own code.

---

## The simpler free alternative

If what you actually want is *"reach it from anywhere"* rather than *"get it
off my laptop"*, **Tailscale** does that in fifteen minutes with no server, no
domain, no certificate, and no ARM build:

1. Install Tailscale on the laptop and on your phone
2. Open `http://<laptop-name>:5173` from anywhere

Free for personal use, encrypted, nothing exposed to the public internet — and
repository indexing keeps working, because the code is still on the machine
holding it. The catch is that the laptop has to stay on.
