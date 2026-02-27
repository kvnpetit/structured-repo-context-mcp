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
    const { server, mock, captured } = makeServer();
    registerResources(server);

    expect(mock).toHaveBeenCalledTimes(1);
    expect(captured.name).toBe("server_info");
    expect(captured.uri).toBe("src://server/info");
  });

  test("server_info resource handler returns valid structure", () => {
    const { server, captured } = makeServer();
    registerResources(server);

    expect(captured.handler).toBeDefined();
    if (captured.handler === undefined) throw new Error("Handler should be defined");

    const result = captured.handler({ href: "src://server/info" });

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]?.mimeType).toBe("application/json");
    expect(result.contents[0]?.uri).toBe("src://server/info");
  });

  test("server_info resource returns valid JSON with expected properties", () => {
    const { server, captured } = makeServer();
    registerResources(server);

    if (captured.handler === undefined) throw new Error("Handler should be defined");

    const result = captured.handler({ href: "src://server/info" });
    const parsed = JSON.parse(result.contents[0]?.text ?? "{}") as Record<
      string,
      unknown
    >;

    expect(parsed).toHaveProperty("name");
    expect(parsed).toHaveProperty("fullName");
    expect(parsed).toHaveProperty("version");
  });
});
