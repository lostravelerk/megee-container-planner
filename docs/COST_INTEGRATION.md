# Cost 主产品同步接口契约

本文件定义 `container-planner` 与 `cost.megee-inc.com` 的只读集成边界。未取得真实接口文档、鉴权方式和可路由地址前，不得以示例数据冒充同步成功。

## 1. 同步范围（严格白名单）

- 以 `productCode` 作为跨系统唯一键。
- 只同步：产品家族/系列号、产品代码、品名、规格、装箱数量。
- Cost 的“装箱数量”映射为 container-planner 的 `EA/BOX`，允许为空，不设置默认值。
- 不同步纸箱尺寸、托盘尺寸、柜型、公差、成本、BOM、客户或其他业务字段。
- 纸箱/托盘参数和装柜方案由 container-planner 独立维护，Cost 同步不得覆盖。
- 治理字段：Cost 记录更新时间、同步时间、数据状态、来源版本。
- Cost 为主数据源；装柜系统只读，不向 Cost 回写。

## 2. 建议响应

```json
{
  "cursor": "next-page-token",
  "items": [
    {
      "productSeries": "string",
      "productCode": "string",
      "productName": "string",
      "specification": "string",
      "packingQuantity": null,
      "updatedAt": "2026-08-26T00:00:00Z"
    }
  ]
}
```

`packingQuantity` 允许为 `null`，前端不得擅自填默认值。

## 3. 连接与安全

- 指定只读同步身份：`cMacStudio@WorkBuddy`；密码、令牌与会话信息不得进入源码、日志、报告或 GitHub。
- 首选由 Cost 暴露 HTTPS 只读 API，并使用短期服务凭据或 mTLS。
- 若 Cost 仅在内网可见，使用 Cloudflare Tunnel 将限定路径暴露给 Worker，禁止把整站直接公开。
- 同步任务在 Worker 定时任务中执行，凭据存入 Cloudflare Secrets，不写入 GitHub 或浏览器。
- 员工方案库必须受 Cloudflare Access 或公司 SSO 保护。
- 对客户只发布单份报告的不可枚举链接；不得暴露产品全集、成本字段或内部接口。

## 4. 方案版本

- 产品主数据与装柜方案分表保存。
- 报告创建时保存完整计算快照，包括 SKU 字段、尺寸、余量、算法版本、结果和图面参数。
- Cost 数据更新后标记相关方案“建议重新计算”，不得静默修改既有客户报告。
- 同步必须幂等；同一 `productCode + updatedAt` 重放不会产生重复记录。

## 5. 接入前置资料

1. Cost API 基础地址和接口文档。
2. API 鉴权方式与只读服务账号。
3. 全量分页、增量游标或 `updatedSince` 规则。
4. 实际字段映射、空值规则和 SKU 唯一键确认。
5. Cloudflare Worker 是否能路由到该地址；若不能，提供 Tunnel 落点或企业 VPN 出口方案。
