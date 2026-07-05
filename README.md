# NIUMA Premium MCP

把 NIUMA 店铺的 Session 型 REST API 封装为远程 MCP 服务，仅提供：

- X Premium 年费
- X Premium+ 年费

套餐价格、付款网络和币种从店铺 `/context` 实时读取；服务不会硬编码价格。

## 暴露的工具

| 工具 | 用途 |
|---|---|
| `list_yearly_plans` | 查询两个年度套餐、实时价格与付款选项 |
| `check_gift_eligibility` | 检查 X 账号是否具备赠送开通资格 |
| `get_eligibility_status` | 查询异步资格检查状态 |
| `register_precheck_email` | 资格未通过时登记通知邮箱 |
| `create_yearly_order` | 创建 Premium / Premium+ 年费订单 |
| `get_order` | 查询付款与开通状态 |
| `submit_payment_tx` | 提交链上付款交易哈希 |

每个 MCP 会话使用独立 PHP Session Cookie。服务不会把 Cookie 写入日志或返回给调用者。

## 本地运行

```powershell
npm install
Copy-Item .env.example .env
npm start
```

健康检查：`GET http://localhost:3000/health`

MCP endpoint：`http://localhost:3000/mcp`

## 测试

```powershell
npm test
npm run check
```

## 部署

可以部署到支持长期运行 Node.js 或 Docker 的平台。生产环境必须：

1. 提供公网 `https://` 域名。
2. 保持单实例，或把 Session 存储替换成共享存储并启用会话粘性。
3. 设置 `WEBSHOP_ORIGIN=https://lanv.niuma.works`。
4. 设置 `WEBSHOP_ENTRY_PATH=/p/niuma`。
5. 建议设置 `ALLOWED_HOSTS` 为 MCP 服务自己的域名。

Docker：

```powershell
docker build -t niuma-premium-mcp .
docker run --rm -p 3000:3000 `
  -e WEBSHOP_ORIGIN=https://lanv.niuma.works `
  -e WEBSHOP_ENTRY_PATH=/p/niuma `
  niuma-premium-mcp
```

部署后的上架 endpoint 应为：

```text
https://你的-MCP-域名/mcp
```

不要使用 `localhost`、内网地址、临时隧道或示例占位域名上架。
