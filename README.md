# 全国基地分布地图（节选）

> 基于高德地图 + DataV GeoJSON 构建，展示各城市公司基地分布、区县边界及 5km 辐射圈。

| 城市 | 基地数量 | 基地分布（按笔画逆序） | 链接 | 更新时间 | 区号代码 | 简称 |
| :---: | :---: | --- | :---: | :---: | :---: | :---: |
| 杭州 | 4 | 拱墅、滨江、西湖、余杭 | [查看地图](https://fengqi-annan.github.io/waixuan/%E6%9D%AD%E5%B7%9E.html) | 260820 | 330100 | 杭 |
| 郑州 | 2 | 管城、金水 | [查看地图](https://fengqi-annan.github.io/waixuan/%E9%83%91%E5%B7%9E.html) | 260820 | 410100 | 郑 |
| 西安 | 2 | 雁塔、莲湖 | [查看地图](https://fengqi-annan.github.io/waixuan/%E8%A5%BF%E5%AE%89.html) | 260820 | 610100 | 镐 |
| 济南 | 2 | 历城、天桥 | [查看地图](https://fengqi-annan.github.io/waixuan/%E6%B5%8E%E5%8D%97.html) | 260820 | 370100 | 济 |

---

### 📌 使用说明
- 点击「查看地图」即可进入对应城市的地图页面
- 地图包含：高德底图 + 区县边界 + 蓝色图钉 + 5km 半径圈
- 点击图钉可查看基地名称和精确经纬度，如有错误请及时反馈
- 适合用于 **招聘定位、业务辐射范围分析、团队分布展示**

---

### 🔗 维护工具

| 开发与维护工具集 | 用途 |
| :---: | :---: |
| [阿里云 DataV 区划选择器](https://datav.aliyun.com/portal/school/atlas/area_selector) | 下载全国省市区的 GeoJSON 边界数据 |
| [高德坐标拾取器](https://lbs.amap.com/tools/picker) | 获取基地精确经纬度坐标 |
| [高德控制台](https://console.amap.com/dev/key/app) | 管理 API Key，配置域名白名单 |

---

### 🛠 技术栈
- 高德地图 JavaScript API 2.0
- DataV.GeoAtlas 行政区划边界数据
- 纯前端 HTML + CSS + JavaScript，无需后端服务
