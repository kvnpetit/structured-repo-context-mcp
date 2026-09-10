import { describe, expect, test, vi } from "vitest";
import { registerResources } from "@resources";

describe("Resource Registration", () => {
  function makeServer() {
    const captured = {
      name: undefined as string | undefined,
      uri: undefined as string | undefined,
      handler: undefined as
        | ((uri: { href: string }) => {
            contents: { uri: string; mimeType: string; text: string }[];
          })
        | undefined,
    };
    const mock = vi.fn(
      (
        name: string,
        uri: string,
        _config: unknown,
        handler: (uri: { href: string }) => {
          contents: { uri: string; mimeType: string; text: string }[];
        },
      ) => {
        captured.name = name;
        captured.uri = uri;
        captured.handler = handler;
      },
    );
    return { server: { registerResource: mock } as never, mock, captured };
  }

  test("registers server_info resource", () => {
    const { server, mock } = makeServer();
    registerResources(server);

    expect(mock).toHaveBeenCalledTimes(3);
    expect(mock).toHaveBeenCalledWith(
      "server_info",
      "src://server/info",
      expect.any(Object),
      expect.any(Function),
    );
    expect(mock).toHaveBeenCalledWith(
      "server_capabilities",
      "src://server/capabilities",
      expect.any(Object),
      expect.any(Function),
    );
    expect(mock).toHaveBeenCalledWith(
      "project_views",
      expect.any(Object),
      expect.any(Object),
      expect.any(Function),
    );
  });

  test("server_info resource handler returns valid structure", () => {
    const { server } = makeServer();
    registerResources(server);

    const call = (
      server as unknown as { registerResource: ReturnType<typeof vi.fn> }
    ).registerResource.mock.calls.find((entry: unknown[]) => entry[0] === "server_info");
    const handler = call?.[3] as
      | ((uri: { href: string }) => {
          contents: { uri: string; mimeType: string; text: string }[];
        })
      | undefined;
    expect(handler).toBeDefined();
    if (handler === undefined) {
      throw new Error("Handler should be defined");
    }

    const result = handler({ href: "src://server/info" });

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]?.mimeType).toBe("application/json");
    expect(result.contents[0]?.uri).toBe("src://server/info");
  });

  test("server_info resource returns valid JSON with expected properties", () => {
    const { server } = makeServer();
    registerResources(server);

    const call = (
      server as unknown as { registerResource: ReturnType<typeof vi.fn> }
    ).registerResource.mock.calls.find((entry: unknown[]) => entry[0] === "server_info");
    const handler = call?.[3] as
      | ((uri: { href: string }) => {
          contents: { uri: string; mimeType: string; text: string }[];
        })
      | undefined;
    if (handler === undefined) {
      throw new Error("Handler should be defined");
    }

    const result = handler({ href: "src://server/info" });
    const parsed = JSON.parse(result.contents[0]?.text ?? "{}") as Record<string, unknown>;

    expect(parsed).toHaveProperty("name");
    expect(parsed).toHaveProperty("fullName");
    expect(parsed).toHaveProperty("version");
  });

  test("server_capabilities resource exposes the enabled catalog", () => {
    const { server } = makeServer();
    registerResources(server);
    const call = (
      server as unknown as { registerResource: ReturnType<typeof vi.fn> }
    ).registerResource.mock.calls.find((entry: unknown[]) => entry[0] === "server_capabilities");
    const handler = call?.[3] as
      | ((uri: { href: string }) => {
          contents: { text: string }[];
        })
      | undefined;
    expect(handler).toBeDefined();
    if (handler === undefined) {
      throw new Error("Capabilities handler should be defined");
    }
    const parsed = JSON.parse(
      handler({ href: "src://server/capabilities" }).contents[0]?.text ?? "{}",
    ) as {
      schema_version?: number;
      local_only?: boolean;
      tool_catalog_revision?: string;
      tools?: { name: string }[];
    };
    expect(parsed.schema_version).toBe(1);
    expect(parsed.local_only).toBe(true);
    expect(parsed.tool_catalog_revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(parsed.tools?.some((tool) => tool.name === "search_code")).toBe(true);
  });
});
