# NFT 评测数据集

## 项目列表

- **dynamic-nft**: [A](runs/dynamic-nft-A/) | [B](runs/dynamic-nft-B/) | [record](records/dynamic-nft.md) | [prompt](prompts/dynamic-nft.md)
- **nft-collection-bids**: [A](runs/nft-collection-bids-A/) | [B](runs/nft-collection-bids-B/) | [record](records/nft-collection-bids.md) | [prompt](prompts/nft-collection-bids.md)
- **nft-indexer**: [A](runs/nft-indexer-A/) | [B](runs/nft-indexer-B/) | [record](records/nft-indexer.md) | [prompt](prompts/nft-indexer.md)
- **nft-loan**: [A](runs/nft-loan-A/) | [B](runs/nft-loan-B/) | [record](records/nft-loan.md) | [prompt](prompts/nft-loan.md)
- **nft-marketplace**: [A](runs/nft-marketplace-A/) | [B](runs/nft-marketplace-B/) | [record](records/nft-marketplace.md) | [prompt](prompts/nft-marketplace.md)
- **nft-ticketing**: [A](runs/nft-ticketing-A/) | [B](runs/nft-ticketing-B/) | [record](records/nft-ticketing.md) | [prompt](prompts/nft-ticketing.md)

## 结构

```
runs/<名>-A/    # A 次运行代码
runs/<名>-B/    # B 次运行代码
records/<名>.md # 数据记录（User Prompt → 需求完整性分析 → GSB）
prompts/<名>.md # 任务 prompt
```

交互轨迹（jsonl）见 Release。

## 复现

每个项目目录下：
```bash
npm install
npm test
npm run accept
```

## 环境信息

- Node.js ≥ 20，TypeScript 5，Fastify 4，better-sqlite3（或 node:sqlite）
- 测试：node:test（Node 内置）
- 验收：npm run accept（一键演练全部场景）
