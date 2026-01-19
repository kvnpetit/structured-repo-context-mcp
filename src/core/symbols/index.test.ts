import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { parseCode, resetParser } from "@core/parser";
import {
  extractCodeInfo,
  extractExports,
  extractImports,
  extractSymbols,
  findSymbolByName,
  getSymbolAtPosition,
  getSymbolsByType,
} from "@core/symbols";

describe("Symbol Extraction - JavaScript", () => {
  beforeEach(() => {
    resetParser();
  });

  afterEach(() => {
    resetParser();
  });

  test("extracts function symbols", async () => {
    const code = `
      function hello() { return "world"; }
      const greet = (name) => "Hello " + name;
    `;
    const result = await parseCode(code, { language: "javascript" });

    const { symbols, summary } = extractSymbols(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(symbols.length).toBeGreaterThan(0);
    expect(summary.functions).toBeGreaterThan(0);

    const helloFunc = symbols.find((s) => s.name === "hello");
    expect(helloFunc).toBeDefined();
    expect(helloFunc?.type).toBe("function");
  });

  test("extracts class symbols", async () => {
    const code = `
      class MyClass {
        constructor() {}
        method() {}
      }
    `;
    const result = await parseCode(code, { language: "javascript" });

    const { symbols, summary } = extractSymbols(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(summary.classes).toBe(1);

    const myClass = symbols.find((s) => s.name === "MyClass");
    expect(myClass).toBeDefined();
    expect(myClass?.type).toBe("class");
  });

  test("extracts variable symbols", async () => {
    const code = `
      const x = 1;
      let y = 2;
      var z = 3;
    `;
    const result = await parseCode(code, { language: "javascript" });

    const { symbols, summary } = extractSymbols(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(summary.constants + summary.variables).toBeGreaterThan(0);

    const xVar = symbols.find((s) => s.name === "x");
    expect(xVar).toBeDefined();
  });

  test("filters symbols by type", async () => {
    const code = `
      function hello() {}
      class MyClass {}
      const x = 1;
    `;
    const result = await parseCode(code, { language: "javascript" });

    const { symbols } = extractSymbols(
      result.tree,
      result.languageInstance,
      "javascript",
      { types: ["function"] },
    );

    // Should only have functions
    expect(symbols.every((s) => s.type === "function")).toBe(true);
  });

  test("excludes symbols by type", async () => {
    const code = `
      function hello() {}
      class MyClass {}
    `;
    const result = await parseCode(code, { language: "javascript" });

    const { symbols } = extractSymbols(
      result.tree,
      result.languageInstance,
      "javascript",
      { excludeTypes: ["class"] },
    );

    // Should not have classes
    expect(symbols.every((s) => s.type !== "class")).toBe(true);
  });
});

describe("Symbol Extraction - TypeScript", () => {
  beforeEach(() => {
    resetParser();
  });

  afterEach(() => {
    resetParser();
  });

  test("extracts TypeScript interfaces", async () => {
    const code = `
      interface User {
        name: string;
        age: number;
      }
    `;
    const result = await parseCode(code, { language: "typescript" });

    const { symbols, summary } = extractSymbols(
      result.tree,
      result.languageInstance,
      "typescript",
    );

    expect(summary.interfaces).toBe(1);

    const userInterface = symbols.find((s) => s.name === "User");
    expect(userInterface).toBeDefined();
    expect(userInterface?.type).toBe("interface");
  });

  test("extracts TypeScript type aliases", async () => {
    const code = `
      type Config = { debug: boolean };
    `;
    const result = await parseCode(code, { language: "typescript" });

    const { symbols, summary } = extractSymbols(
      result.tree,
      result.languageInstance,
      "typescript",
    );

    expect(summary.types).toBe(1);

    const configType = symbols.find((s) => s.name === "Config");
    expect(configType).toBeDefined();
    expect(configType?.type).toBe("type");
  });

  test("extracts TypeScript enums", async () => {
    const code = `
      enum Status {
        Active,
        Inactive
      }
    `;
    const result = await parseCode(code, { language: "typescript" });

    const { symbols, summary } = extractSymbols(
      result.tree,
      result.languageInstance,
      "typescript",
    );

    expect(summary.enums).toBe(1);

    const statusEnum = symbols.find((s) => s.name === "Status");
    expect(statusEnum).toBeDefined();
    expect(statusEnum?.type).toBe("enum");
  });
});

describe("Symbol Extraction - Python", () => {
  beforeEach(() => {
    resetParser();
  });

  afterEach(() => {
    resetParser();
  });

  test("extracts Python functions", async () => {
    const code = `
def hello():
    return "world"

def greet(name):
    return f"Hello {name}"
    `;
    const result = await parseCode(code, { language: "python" });

    const { symbols, summary } = extractSymbols(
      result.tree,
      result.languageInstance,
      "python",
    );

    expect(summary.functions).toBe(2);

    const helloFunc = symbols.find((s) => s.name === "hello");
    expect(helloFunc).toBeDefined();
    expect(helloFunc?.type).toBe("function");
  });

  test("extracts Python classes", async () => {
    const code = `
class MyClass:
    def method(self):
        pass
    `;
    const result = await parseCode(code, { language: "python" });

    const { summary } = extractSymbols(
      result.tree,
      result.languageInstance,
      "python",
    );

    expect(summary.classes).toBe(1);
  });
});

describe("Import Extraction", () => {
  beforeEach(() => {
    resetParser();
  });

  afterEach(() => {
    resetParser();
  });

  test("extracts JavaScript imports", async () => {
    const code = `
      import { x, y } from 'module';
      import z from 'other';
      import * as all from 'third';
    `;
    const result = await parseCode(code, { language: "javascript" });

    const imports = extractImports(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(imports.length).toBeGreaterThan(0);
  });

  test("extracts Python imports", async () => {
    const code = `
import os
from pathlib import Path
from typing import List, Dict
    `;
    const result = await parseCode(code, { language: "python" });

    const imports = extractImports(
      result.tree,
      result.languageInstance,
      "python",
    );

    expect(imports.length).toBeGreaterThan(0);
  });
});

describe("Export Extraction", () => {
  beforeEach(() => {
    resetParser();
  });

  afterEach(() => {
    resetParser();
  });

  test("extracts JavaScript exports", async () => {
    const code = `
      export const x = 1;
      export function hello() {}
      export default class MyClass {}
    `;
    const result = await parseCode(code, { language: "javascript" });

    const exports = extractExports(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(exports.length).toBeGreaterThan(0);

    const defaultExport = exports.find((e) => e.isDefault);
    expect(defaultExport).toBeDefined();
  });
});

describe("Symbol Utilities", () => {
  beforeEach(() => {
    resetParser();
  });

  afterEach(() => {
    resetParser();
  });

  test("getSymbolsByType filters correctly", async () => {
    const code = `
      function hello() {}
      class MyClass {}
    `;
    const result = await parseCode(code, { language: "javascript" });

    const { symbols } = extractSymbols(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    const functions = getSymbolsByType(symbols, "function");
    expect(functions.every((s) => s.type === "function")).toBe(true);
  });

  test("findSymbolByName finds correct symbol", async () => {
    const code = `
      function hello() {}
      function world() {}
    `;
    const result = await parseCode(code, { language: "javascript" });

    const { symbols } = extractSymbols(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    const found = findSymbolByName(symbols, "hello");
    expect(found).toBeDefined();
    expect(found?.name).toBe("hello");
  });

  test("findSymbolByName returns undefined for unknown name", async () => {
    const code = `function hello() {}`;
    const result = await parseCode(code, { language: "javascript" });

    const { symbols } = extractSymbols(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    const found = findSymbolByName(symbols, "unknown");
    expect(found).toBeUndefined();
  });

  test("getSymbolAtPosition finds symbol at position", async () => {
    const code = `function hello() { return 1; }`;
    const result = await parseCode(code, { language: "javascript" });

    const { symbols } = extractSymbols(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    const found = getSymbolAtPosition(symbols, 1, 15);
    expect(found).toBeDefined();
    expect(found?.name).toBe("hello");
  });
});

describe("Code Info Extraction", () => {
  beforeEach(() => {
    resetParser();
  });

  afterEach(() => {
    resetParser();
  });

  test("extractCodeInfo returns complete info", async () => {
    const code = `
      import { x } from 'module';

      export function hello() {}

      class MyClass {}
    `;
    const parseResult = await parseCode(code, { language: "javascript" });

    const info = extractCodeInfo(
      parseResult.tree,
      parseResult.languageInstance,
      "javascript",
    );

    expect(info.symbols.symbols.length).toBeGreaterThan(0);
    expect(info.imports.length).toBeGreaterThan(0);
    expect(info.exports.length).toBeGreaterThan(0);
  });
});

describe("Import Edge Cases", () => {
  beforeEach(() => {
    resetParser();
  });

  afterEach(() => {
    resetParser();
  });

  test("extracts default imports", async () => {
    const code = `import React from 'react';`;
    const result = await parseCode(code, { language: "javascript" });

    const imports = extractImports(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(imports.length).toBe(1);
    expect(imports[0]).toBeDefined();
  });

  test("extracts named imports with multiple names", async () => {
    const code = `import { useState, useEffect, useCallback } from 'react';`;
    const result = await parseCode(code, { language: "javascript" });

    const imports = extractImports(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(imports.length).toBe(1);
    expect(imports[0]).toBeDefined();
  });

  test("extracts mixed default and named imports", async () => {
    const code = `import React, { useState, useEffect } from 'react';`;
    const result = await parseCode(code, { language: "javascript" });

    const imports = extractImports(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(imports.length).toBe(1);
    expect(imports[0]).toBeDefined();
  });

  test("extracts multiple import statements", async () => {
    const code = `
import React from 'react';
import { render } from 'react-dom';
import * as utils from './utils';
    `;
    const result = await parseCode(code, { language: "javascript" });

    const imports = extractImports(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(imports.length).toBeGreaterThanOrEqual(2);
  });

  test("handles namespace imports", async () => {
    const code = `import * as fs from 'fs';`;
    const result = await parseCode(code, { language: "javascript" });

    const imports = extractImports(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(imports.length).toBe(1);
    expect(imports[0]).toBeDefined();
  });
});

describe("Export Edge Cases", () => {
  beforeEach(() => {
    resetParser();
  });

  afterEach(() => {
    resetParser();
  });

  test("extracts export default function", async () => {
    const code = `export default function hello() {}`;
    const result = await parseCode(code, { language: "javascript" });

    const exports = extractExports(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(exports.length).toBe(1);
    expect(exports[0]?.isDefault).toBe(true);
  });

  test("extracts export default class", async () => {
    const code = `export default class MyClass {}`;
    const result = await parseCode(code, { language: "javascript" });

    const exports = extractExports(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(exports.length).toBe(1);
    expect(exports[0]?.isDefault).toBe(true);
  });

  test("extracts named exports", async () => {
    const code = `export const a = 1; export let b = 2; export var c = 3;`;
    const result = await parseCode(code, { language: "javascript" });

    const exports = extractExports(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(exports.length).toBe(3);
  });

  test("extracts export interface in TypeScript", async () => {
    const code = `export interface User { name: string; }`;
    const result = await parseCode(code, { language: "typescript" });

    const exports = extractExports(
      result.tree,
      result.languageInstance,
      "typescript",
    );

    expect(exports.length).toBeGreaterThan(0);
  });

  test("extracts export type in TypeScript", async () => {
    const code = `export type Status = 'active' | 'inactive';`;
    const result = await parseCode(code, { language: "typescript" });

    const exports = extractExports(
      result.tree,
      result.languageInstance,
      "typescript",
    );

    expect(exports.length).toBeGreaterThan(0);
  });

  test("extracts export enum in TypeScript", async () => {
    const code = `export enum Color { Red, Green, Blue }`;
    const result = await parseCode(code, { language: "typescript" });

    const exports = extractExports(
      result.tree,
      result.languageInstance,
      "typescript",
    );

    expect(exports.length).toBeGreaterThan(0);
  });
});

describe("Function Signature Extraction", () => {
  beforeEach(() => {
    resetParser();
  });

  afterEach(() => {
    resetParser();
  });

  test("extracts arrow function symbols", async () => {
    const code = `const greet = (name: string): string => name;`;
    const result = await parseCode(code, { language: "typescript" });

    const { symbols } = extractSymbols(
      result.tree,
      result.languageInstance,
      "typescript",
    );

    expect(symbols.length).toBeGreaterThan(0);
  });

  test("extracts Python function symbols", async () => {
    const code = `
def greet(name: str) -> str:
    return f"Hello {name}"

def add(a: int, b: int) -> int:
    return a + b
    `;
    const result = await parseCode(code, { language: "python" });

    const { symbols, summary } = extractSymbols(
      result.tree,
      result.languageInstance,
      "python",
    );

    expect(summary.functions).toBe(2);
    expect(symbols.some((s) => s.name === "greet")).toBe(true);
  });

  test("extracts Go function symbols", async () => {
    const code = `
package main

func greet(name string) string {
    return "Hello " + name
}

func (s *Server) Start() error {
    return nil
}
    `;
    const result = await parseCode(code, { language: "go" });

    const { symbols } = extractSymbols(
      result.tree,
      result.languageInstance,
      "go",
    );

    expect(symbols.length).toBeGreaterThan(0);
  });
});

describe("Import/Export Deduplication", () => {
  beforeEach(() => {
    resetParser();
  });

  afterEach(() => {
    resetParser();
  });

  test("handles imports with both default and named imports", async () => {
    const code = `
import React, { useState, useEffect, useCallback } from 'react';
import { render } from 'react-dom';
    `;
    const result = await parseCode(code, { language: "javascript" });

    const imports = extractImports(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    expect(imports.length).toBeGreaterThanOrEqual(1);
  });

  test("deduplicates repeated export patterns", async () => {
    const code = `
export const a = 1;
export const b = 2;
export function hello() {}
export class MyClass {}
    `;
    const result = await parseCode(code, { language: "javascript" });

    const exports = extractExports(
      result.tree,
      result.languageInstance,
      "javascript",
    );

    // Each export should appear only once
    const names = exports.map((e) => e.name);
    const uniqueNames = [...new Set(names)];
    expect(names.length).toBe(uniqueNames.length);
  });
});
