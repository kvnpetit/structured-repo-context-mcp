# SRC (Structured Repo Context)

> **Transform your codebase into AI-ready context** — The MCP server that makes your code truly understandable for AI assistants

[![CI](https://github.com/kvnpetit/structured-repo-context-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/kvnpetit/structured-repo-context-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/kvnpetit/structured-repo-context-mcp/branch/main/graph/badge.svg)](https://codecov.io/gh/kvnpetit/structured-repo-context-mcp)
[![npm version](https://img.shields.io/npm/v/src-mcp.svg)](https://www.npmjs.com/package/src-mcp)
[![npm downloads](https://img.shields.io/npm/dm/src-mcp.svg)](https://www.npmjs.com/package/src-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blue.svg)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)

---

## 🎯 Why SRC?

**Stop losing context.** Most AI assistants struggle to understand your entire codebase, leading to hallucinated code, outdated references, and endless back-and-forth.

**SRC changes the game** by parsing your repository into semantic, searchable chunks that LLMs actually understand.

### The Problem

- ❌ AI assistants only see snippets of your code
- ❌ Manual copy-pasting of context is tedious
- ❌ Keyword search misses semantic relationships
- ❌ Code changes get lost in conversation history

### The Solution

- ✅ **Semantic code search** — Find by meaning, not keywords
- ✅ **Automatic context extraction** — Let AI see the whole picture
- ✅ **Treesitter parsing** — Accurate AST-level understanding
- ✅ **Embedding-based indexing** — Vector search for code intelligence
- ✅ **MCP native** — Works with Claude, and any MCP-compatible AI

---

## ⚡ Quick Start

Get started in **30 seconds**:

### Without Installation

**bun (recommended):**

```bash
bunx src-mcp serve
```

**npm:**

```bash
npx src-mcp serve
```

### Add to Your MCP Client

Add this configuration to your MCP client:

**bun (recommended):**

```json
{
  "mcpServers": {
    "src-mcp": {
      "command": "bunx",
      "args": ["src-mcp", "serve"]
    }
  }
}
```

**npm:**

```json
{
  "mcpServers": {
    "src-mcp": {
      "command": "npx",
      "args": ["-y", "src-mcp", "serve"]
    }
  }
}
```

**Restart your MCP client** — That's it! 🎉

---

## 🚀 What You Get

### Semantic Code Search

```
You: "Find all authentication logic"
AI: [Retrieves auth middleware, login handlers, JWT validation]
```

Instead of grepping for "auth", SRC understands **what** you mean and finds **related** code.

### Intelligent Context

```
Source Code → Treesitter → AST → Metadata → Embeddings → Indexed Context
              (parse)      (tree)  (enrich)   (vectors)   (search)
```

Your AI assistant gets:

- 📝 **Function signatures** with full type information
- 🔗 **Import relationships** and dependencies
- 📊 **Code structure** (classes, interfaces, modules)
- 🎯 **Semantic meaning** through embeddings

---

## 💡 Use Cases

### For Developers

- 🔍 **Code Review:** "Show me all error handling in the payment module"
- 🐛 **Debugging:** "Find where user sessions are created"
- 📚 **Documentation:** "Explain the authentication flow"
- ♻️ **Refactoring:** "List all deprecated API usages"

### For Teams

- 🎓 **Onboarding:** New devs understand the codebase faster
- 🏗️ **Architecture:** Map dependencies and relationships
- 🔒 **Security Audits:** Find all data access points
- 📈 **Code Quality:** Identify patterns and anti-patterns

---

## 🛠️ Available MCP Tools

SRC provides **4 powerful code analysis tools**:

| Tool | Description |
| ---- | ----------- |
| **`analyze_file`** | Comprehensive file analysis — symbols, imports, exports, metrics |
| **`parse_ast`** | Parse code and return Abstract Syntax Tree with depth control |
| **`query_code`** | Execute Tree-sitter SCM queries (8 presets + custom patterns) |
| **`list_symbols`** | Extract structured symbols (functions, classes, variables, etc.) |

### Supported Languages

**Full AST Support (18 languages):**
JavaScript, TypeScript, TSX, Python, Go, Rust, Java, C, C++, C#, PHP, Ruby, HTML, Svelte, Kotlin, Scala, OCaml, Swift

**Intelligent Fallback (~30+ additional languages):**
Language-aware text splitting for any language not in the AST list

---

## ✨ Features

| Feature                | Benefit                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| **Treesitter Parsing** | Fast, accurate syntax parsing with SCM query support              |
| **AST Analysis**       | Deep code structure understanding (symbols, relationships, scope) |
| **Symbol Extraction**  | Functions, classes, variables, imports, exports with position info |
| **SCM Queries**        | Preset queries (functions, classes, imports) + custom patterns    |
| **Vector Embeddings**  | Semantic search that understands code meaning                     |
| **Context Enrichment** | Metadata, types, imports, and cross-references                    |
| **MCP Protocol**       | Works with any MCP-compatible client                              |
| **CLI Interface**      | Direct usage without MCP for testing and automation               |
| **TypeScript First**   | Built with strict TypeScript for reliability                      |
| **Zero Config**        | Works out of the box, customize when needed                       |

---

## 📦 Installation

### Global Installation

**bun (recommended):**

```bash
bun add -g src-mcp
```

**npm:**

```bash
npm install -g src-mcp
```

Then use directly:

```bash
src-mcp help
src-mcp version
src-mcp get_server_info --format json
```

---

## 🎮 Usage

### MCP Configuration

**Using bunx (recommended, no installation):**

```json
{
  "mcpServers": {
    "src-mcp": {
      "command": "bunx",
      "args": ["src-mcp", "serve"]
    }
  }
}
```

**Using npx (alternative):**

```json
{
  "mcpServers": {
    "src-mcp": {
      "command": "npx",
      "args": ["-y", "src-mcp", "serve"]
    }
  }
}
```

**Using global installation:**

```json
{
  "mcpServers": {
    "src-mcp": {
      "command": "src-mcp",
      "args": ["serve"]
    }
  }
}
```

### CLI Usage

**bun (recommended):**

```bash
bunx src-mcp get_server_info --format json
bunx src-mcp version
bunx src-mcp help
```

**npm:**

```bash
npx src-mcp get_server_info --format json
npx src-mcp version
npx src-mcp help
```

---

## 🌟 Why Choose SRC?

### For Individual Developers

- ⚡ **Instant Setup** — npx/bunx, no installation required
- 🎯 **Focused Context** — AI sees only what matters
- 🚀 **Productivity Boost** — 10x faster code exploration
- 🧩 **Extensible** — Add custom tools and features

### For Teams

- 👥 **Knowledge Sharing** — Faster onboarding, better collaboration
- 🏗️ **Code Quality** — Automated insights and patterns
- 📊 **Documentation** — Always up-to-date context
- 🔒 **Self-Hosted** — Your code never leaves your machine

### For Open Source

- 🌍 **Community Driven** — Built on open standards (MCP)
- 🔓 **MIT Licensed** — Use anywhere, modify freely
- 📦 **TypeScript Native** — Easy to fork and extend
- 🤝 **Contribution Friendly** — Clear architecture, great docs

---

## 📚 Documentation

### Project Documentation

- 📖 **[Development Guide](./GUIDE.md)** — Architecture, patterns, and technical details
- 🤝 **[Contributing Guide](./CONTRIBUTING.md)** — How to contribute to this project
- 📋 **[Changelog](./CHANGELOG.md)** — Version history
- 📄 **[LICENSE](./LICENSE)** — MIT License
- 🤝 **[Code of Conduct](./CODE_OF_CONDUCT.md)** — Community guidelines

### External Resources

- 📘 [MCP Specification](https://modelcontextprotocol.io/specification)
- 🛠️ [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

---

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](./CONTRIBUTING.md) for details on:

- Setting up your development environment
- Running tests and quality checks
- Submitting pull requests
- Code style and conventions

---

## 📊 Project Info

- **TypeScript:** Strict mode with ultra-strict ESLint
- **Testing:** Vitest with 80% coverage threshold
- **CI/CD:** GitHub Actions (lint, typecheck, test, build, publish)
- **License:** MIT
- **MCP Compatible:** ✅ Works with all MCP-compatible clients

---

## 📄 License

[MIT](./LICENSE) © 2026 kvnpetit

---

<div align="center">

**🚀 Ready to supercharge your AI coding experience?**

```bash
bunx src-mcp serve   # or: npx src-mcp serve
```

**⭐ Star this repo if SRC helps you code smarter!**

[Report Bug](https://github.com/kvnpetit/structured-repo-context-mcp/issues) • [Request Feature](https://github.com/kvnpetit/structured-repo-context-mcp/issues) • [Documentation](./GUIDE.md)

</div>
