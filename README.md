# ✨ Nebulosa

**Nebulosa** is a platform for **Zoom automation, moderation, and meeting security**.

It provides hosts and co-hosts with **real-time automation tools**, **smart moderation systems**, and **extensible integrations** to simplify meeting management.

Nebulosa helps eliminate repetitive host actions and keeps meetings organized, secure, and easy to run.

---

## 🧠 Core Idea

Zoom meetings often require constant manual intervention:

• granting permissions  
• managing raised hands  
• moderating chat  
• enforcing meeting rules  
  
Nebulosa automates these tasks so hosts can focus on the meeting instead of the controls.

---

## ⚡ Features

### Multi-Pin Automation
Automatically grant **Multi-Pin permissions** when participants raise their hand.

### Real-Time Meeting Automation
Detect meeting events such as:

• participant joins  
• raised hands  
• camera status  
• chat messages  
  
and trigger automation workflows.

### Smart Moderation
Identify suspicious activity and support moderation actions such as:

• chat monitoring  
• spam detection  
• automated warnings  
• participant management

### Extensible Automation
Nebulosa is designed to support additional automation modules and custom scripts.

---

## 🏗 Architecture

Nebulosa is built as a lightweight automation system combining several layers:

Zoom Web Client  
↓  
Event Detection Layer  
↓  
Automation Engine  
↓  
Host Control Actions

Key components:

• **event detection** (meeting activity)  
• **automation engine** (decision logic)  
• **interaction layer** (host actions in Zoom)  
• **extension modules**

---

## 🔧 Current Modules

The first Nebulosa modules include:

• Multi-Pin automation  
• raised-hand detection  
• meeting interaction scripts  
• moderation hooks

Additional modules will expand automation capabilities over time.

---

## 🔑 Secret Management (Doppler)

All configuration values and secrets are managed through **[Doppler](https://doppler.com)**.

This means sensitive settings (API keys, moderation word lists, feature flags)
are never hard-coded in source files.  Instead, a build step injects them
into the compiled userscripts at deploy time.

```bash
# Install Doppler CLI, then:
doppler setup           # link to the "nebulosa" project
doppler run -- npm run build   # compile scripts with secrets injected
# Install from dist/ in Tampermonkey
```

See **[docs/doppler-setup.md](docs/doppler-setup.md)** for a complete setup guide.

---


Nebulosa is currently in **active development**.

The project focuses first on:

• reliable Zoom event detection  
• stable automation workflows  
• simple host tools that can be deployed quickly

Future versions will expand moderation tools and integrations.

---

## 🌌 Vision

Nebulosa aims to become a **powerful automation platform for Zoom hosts**, providing tools that simplify meeting management while remaining lightweight and flexible.

Automation should feel natural and unobtrusive — working quietly in the background to help meetings run smoothly.

---

## 🐾 Frisky Origins

Made with a **Frisky Paw and a brave little heart**—  
for every soul who dares to shine on Zoom. ✨

---

## 🤝 Contributing

Nebulosa is an evolving project and contributions are welcome.

Ideas, improvements, and automation modules are encouraged.

---

## 📜 License

License details will be defined as the project evolves.