# mysql-mcp-server
MCP MySQL server for Continue.dev (MCP 2024 compatible). Tested at Visual Studio Code (1.106.2), Continue.Dev (1.2.10), Local LLM Connected to ollama model Qwen3-Coder:8b. Please check continue mcp yaml example


## Install
- go to your current project folder
- git clone https://github.com/psetiawan/mysql_mcp_server.git
- cd mysql_mcp_server
- npm install

## Run
for testing
```
node server.js --mysql --host localhost --database DBNAME --user USERNAME --password YOURPASS
```

## YAML Configuration
Continue.dev MCP YAML configuration
- go to your project folder
- create .continue/mcpServers
- create continue config yaml, for example mysql-mcp.yaml

or create new mcp from continue dev config

Example :
```
name: MyProject
version: 0.0.1
mcpServers:
  - name: mysql-mcp  
    type: stdio
    command: node
    args: 
      - "./mysql_mcp_server/server.js" 
      - "--mysql"
      - "--host"
      - "localhost"
      - "--database"
      - "DBNAME"
      - "--port"
      - "3306"
      - "--user"
      - "USERNAME"
      - "--password"
      - "YOURPASS"
```

## Usage
at continue prompt (agent/chat/plan) use @mysql-mcp resources, for example @users show users


## Notes
- This implementation implements initialize/initialized, resources/templates/list and resources/templates/get,
  returns full resource descriptors with name, description, mimeType, and provides full tool descriptors with inputSchema.
- The zip also includes your original uploaded file at /mnt/data/index.js for reference.
