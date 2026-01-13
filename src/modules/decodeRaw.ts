import * as protobuf from "protobufjs";
import fs from "fs";
import path from "path";

/* ================== 工具函数 ================== */

function isPrintableUtf8(buf: Uint8Array): boolean {
    try {
        const s = Buffer.from(buf).toString("utf8");
        return (
            s.length > 0 &&
            /^[\x09\x0A\x0D\x20-\x7E\u4e00-\u9fa5]+$/.test(s)
        );
    } catch {
        return false;
    }
}

function wireName(wire: number): string {
    switch (wire) {
        case 0: return "varint";
        case 1: return "fixed64";
        case 2: return "length-delimited";
        case 5: return "fixed32";
        default: return "unknown";
    }
}


/* ================== AST 结构 ================== */

type RawNode =
    | {
          field: number;
          wire: number;
          kind: "value";
          value: string | number;
          
      }
    | {
        field: number;
        wire: number; // length-delimited
        kind: "message";
        children: RawNode[];
      };




/* ================== 核心解析 ================== */

function parseDecodeRaw(reader: protobuf.Reader): RawNode[] {
    const nodes: RawNode[] = [];

    while (reader.pos < reader.len) {
        const startPos = reader.pos;

        let tag: number;
        try {
            tag = reader.uint32();
        } catch {
            break;
        }

        const field = tag >>> 3;
        const wire = tag & 0x07;

        switch (wire) {
            case 0: // varint
                nodes.push({
                    field,
                    wire,
                    kind: "value",
                    value: reader.int64().toString(),
                });
                break;

            case 1: // 64-bit
                nodes.push({
                    field,
                    wire,
                    kind: "value",
                    value: reader.fixed64().toString(),
                });
                break;

            case 2: {
                const len = reader.uint32();
                const end = reader.pos + len;
                if (end > reader.len) return nodes;

                const buf = reader.buf.subarray(reader.pos, end);
                reader.pos = end;

                // 1️⃣ 尝试子 message（必须完整吃完）
                try {
                    const sub = protobuf.Reader.create(buf);
                    const children = parseDecodeRaw(sub);
                    if (sub.pos === sub.len) {
                        nodes.push({ field, wire, kind: "message", children });
                        break;
                    }
                } catch {}

                // 2️⃣ UTF-8 string（数字字符串 / 中文）
                if (isPrintableUtf8(buf)) {
                    nodes.push({
                        field,
                        wire,
                        kind: "value",
                        value: `"${Buffer.from(buf).toString("utf8")}"`,
                    });
                    break;
                }

                // 3️⃣ bytes(hex)
                nodes.push({
                    field,
                    wire,
                    kind: "value",
                    value: Buffer.from(buf).toString("hex"),
                });
                break;
            }

            case 5: // 32-bit
                nodes.push({
                    field,
                    wire,
                    kind: "value",
                    value: reader.fixed32(),
                });
                break;

            default:
                // decode_raw 模式：未知 wire，直接终止当前 message
                return nodes;
        }

        // 防止死循环
        if (reader.pos <= startPos) break;
    }

    return nodes;
}

/* ================== 输出 ================== */

function writeDecodeRaw(
    nodes: RawNode[],
    lines: string[],
    indent = ""
) {
    for (const n of nodes) {
        const wireLabel = wireName(n.wire);
        if ("children" in n) {
            lines.push(`${indent}${n.field} {`);
            writeDecodeRaw(n.children, lines, indent + "  ");
            lines.push(`${indent}}`);
        } else {
            lines.push(`${indent}${n.field}: ${n.value} (${wireLabel})`);
        }
    }
}

/* ================== 入口 ================== */

export function decodeLikeProtoc(buf: Uint8Array): string {
    const reader = protobuf.Reader.create(buf);
    const tree = parseDecodeRaw(reader);

    const lines: string[] = [];
    writeDecodeRaw(tree, lines);

    return lines.join("\n");
}

/* ================== 输出至文件 ================== */
export function dumpRawByMsgId(msgId: number, content: string) {
    const dir = path.resolve(process.cwd(), "logs/protobuf-raw");

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const file = path.join(dir, `${msgId}.txt`);

    const header =
        `\n\n# msgId=${msgId}\n` +
        `# time=${new Date().toISOString()}\n\n`;

    fs.appendFileSync(file, header + content, "utf8");
}