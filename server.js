// server.js - Patched MCP MySQL server (MCP 2024 compliance)
import mysql from 'mysql2/promise';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

class JsonRpcStdio {
  constructor() {
    this.pending = new Map();
    this.buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => this._onData(chunk));
  }
  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { console.error('[ERROR] Invalid JSON from client:', line); continue; }
      this._handleMessage(obj);
    }
  }
  _handleMessage(msg) {
    if (msg.method) this.onRequest && this.onRequest(msg);
    else if (msg.id) {
      const resolver = this.pending.get(msg.id);
      if (resolver) { resolver(msg); this.pending.delete(msg.id); }
    }
  }
  async send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }
}

class MCPServer {
  constructor({ name, version, capabilities }) {
    this.name = name;
    this.version = version;
    this.capabilities = capabilities;
    this.handlers = new Map();
    this.transport = new JsonRpcStdio();
    this.transport.onRequest = (msg) => this._onRequest(msg);
  }
  setHandler(method, fn) { this.handlers.set(method, fn); }
  async _onRequest(msg) {
    const { id, method, params } = msg;
    if (!this.handlers.has(method)) {
      await this.transport.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
      return;
    }
    try {
      const result = await this.handlers.get(method)(params || {});
      await this.transport.send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      console.error('[ERROR] handler threw', err);
      await this.transport.send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
    }
  }
  async announce() {
    await this.transport.send({ jsonrpc: '2.0', method: 'mcp/announce', params: { name: this.name, version: this.version, capabilities: this.capabilities } });
  }
}

function safeString(v){ return (v === null || v === undefined) ? '' : String(v); }

async function createServer(config) {
  const pool = await mysql.createPool({
    host: config.host,
    user: config.user,
    password: config.password,
    database: config.database,
    port: config.port,
    waitForConnections: true,
    connectionLimit: 10
  });

  const capabilities = {
    resources: { list: true, read: true, listChanged: true, templates: true },
    tools: { list: true, call: true }
  };

  const server = new MCPServer({ name: 'mysql-mcp-server', version: '1.0.1', capabilities });

  // REQUIRED: initialize (MCP 2024)
  server.setHandler("initialize", async () => {
    return {
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: server.name,
        version: server.version
      },
      capabilities: server.capabilities,

      // REQUIRED by Continue.dev (even if empty)
      resourceTemplates: []
    };
  });

  server.setHandler('initialized', async () => ({ }));

  // resources/list -> list tables with required fields (uri, name, mimeType, description)
  server.setHandler('resources/list', async () => {
    const [tables] = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = ?", [config.database]);
    const resources = tables.map((t) => {
      const tableName = safeString(t.TABLE_NAME || t.table_name || t.Table_name);
      return {
        uri: `mysql://${config.database}/${tableName}`,
        name: tableName,
        description: `MySQL table ${tableName} in ${config.database}`,
        mimeType: 'application/json'
      };
    });
    return { resources };
  });

  // resources/read -> read rows with limit/offset
  server.setHandler('resources/read', async ({ uri, limit = 100, offset = 0 }) => {
    if (!uri) throw new Error("uri required");

    const parts = uri.replace("mysql://", "").split("/");
    const table = parts[1] || parts[0];
    const sanitized = table.replace(/[^a-zA-Z0-9_]/g, "");

    const [rows] = await pool.query(
      `SELECT * FROM \`${sanitized}\` LIMIT ? OFFSET ?`,
      [Number(limit), Number(offset)]
    );

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(rows, null, 2)
        }
      ]
    };
  });

  // templates list & get (new expected method names)
  server.setHandler("resources/templates/list", async () => {
    return {
      resourceTemplates: [
        {
          id: "top10",
          name: "Top 10 rows",
          uriTemplate: "mysql://{{database}}/{{table}}"
        },
        {
          id: "top100",
          name: "Top 100 rows",
          uriTemplate: "mysql://{{database}}/{{table}}"
        }
      ]
    };
  });

  server.setHandler('resources/templates/get', async ({ uri, templateId }) => {
    if (!uri || !templateId) throw new Error('uri and templateId required');

    const parts = uri.replace('mysql://', '').split('/');
    const table = parts[1] || parts[0];
    const sanitized = table.replace(/[^a-zA-Z0-9_]/g, '');
    const limit = templateId === 'top100' ? 100 : 10;

    const [rows] = await pool.query(
      `SELECT * FROM \`${sanitized}\` LIMIT ?`,
      [limit]
    );

    return {
      resourceTemplate: {
        uri,
        contents: JSON.stringify(rows)
      }
    };
  });

  // tools/list -> provide full tool descriptor including inputSchema/outputSchema
  server.setHandler('tools/list', async () => {
    return {
      tools: [
        {
          name: 'query',
          description: 'Execute a read-only SELECT query',
          inputSchema: {
            type: 'object',
            properties: {
              sql: { type: 'string', description: 'A SELECT SQL query' }
            },
            required: ['sql']
          },
          outputSchema: {
            type: 'object',
            properties: {
              result: { type: 'array' }
            }
          }
        }
      ]
    };
  });

  // tools/call -> execute tool, using safe checks
  server.setHandler('tools/call', async ({ name, arguments: args }) => {
    if (name !== 'query') return { error: 'Unknown tool' };
    const sql = String(args?.sql || '');
    if (!/^\s*SELECT\s+/i.test(sql)) return { error: 'Only SELECT queries allowed' };
    const [rows] = await pool.query(sql);
    return { result: rows };
  });

  // graceful shutdown
  process.on('SIGINT', async () => { try { await pool.end(); } catch(e){}; process.exit(0); });
  process.on('SIGTERM', async () => { try { await pool.end(); } catch(e){}; process.exit(0); });

  await server.announce();
  return { server, pool };
}

async function main(){
  const argv = yargs(hideBin(process.argv)).argv;
  if (!argv.mysql) { console.error('Use --mysql'); process.exit(1); }
  const config = {
    host: argv.host || 'localhost',
    user: argv.user || 'root',
    password: argv.password || '',
    database: argv.database || 'test',
    port: argv.port ? parseInt(argv.port) : 3306
  };
  const { pool } = await createServer(config);
  console.error('[INFO] MySQL MCP Server running');
  process.stdin.resume();
}

main();
