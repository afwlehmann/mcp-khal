import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect } from "vitest";
import { createServer } from "../server.js";
import { itReq, sandbox, unfold } from "../testlib.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

itReq(
  "RFC7986:5.3:uid-uuid-recommended",
  "new_event writes a bare, hex-encoded random UUID (v4) as UID, with the production uid source",
  async () => {
    const sb = await sandbox();
    try {
      const settings = await sb.settings(["work"]);
      const server = createServer(settings, { uid: randomUUID, now: () => new Date("2026-11-02T10:00:00Z") });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "mcp-khal-test", version: "0.0.0" });
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const r = await client.callTool({
        name: "new_event",
        arguments: { calendar: "work", start: "2026-11-04T10:00", duration: "1h", summary: "Uuid" },
      });
      expect((r as { isError?: boolean }).isError).not.toBe(true);
      await client.close();

      const dir = await sb.vdir("work");
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      const text = unfold(await readFile(join(dir, files[0] ?? ""), "utf8"));
      const uid = /\r\nUID:(.*)\r\n/.exec(text)?.[1] ?? "";
      expect(uid).toMatch(UUID_V4);
      expect(files[0]).toBe(`${uid}.ics`);
    } finally {
      await sb.cleanup();
    }
  },
);
