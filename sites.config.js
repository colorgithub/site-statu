'use strict';

/**
 * 监控目标配置 —— 平时只需要改这个文件。
 *
 * 每个站点支持以下字段：
 *   id      唯一标识（英文，用于保存历史数据，改动会丢失旧历史）
 *   name    显示名称
 *   url     要探测的完整地址（http / https 均可，可带路径）
 *   group   分组名（用于面板分组展示，可省略）
 *   note    备注（可省略，鼠标悬停显示）
 */

module.exports = {
  /* 面板标题 */
  title: '站点状态',
  subtitle: '实时监控各站点可用性与响应速度',

  /* 探测间隔（毫秒），默认 60 秒 */
  intervalMs: 60 * 1000,

  /* 单次请求超时（毫秒） */
  timeoutMs: 10 * 1000,

  /* 响应耗时超过该值（毫秒）标记为「缓慢」 */
  slowMs: 1500,

  /* 每个站点保留的最近检测次数（面板展示最近 40 次） */
  historySize: 60,

  /* 服务监听端口，也可用环境变量 PORT 覆盖 */
  port: 3000,

  /* ---------- 要监控的站点 ---------- */
  sites: [
    { id: 'blog-colordev',  name: 'colordev.space',        url: 'https://blog.colordev.space',        group: '博客' },
    { id: 'blog-dpdns',     name: 'color111111.dpdns.org', url: 'https://blog.color111111.dpdns.org', group: '博客' },

    { id: 'vault-colordev', name: 'colordev.space',        url: 'https://vault.colordev.space',       group: 'Vault' },
    { id: 'vault-dpdns',    name: 'color111111.dpdns.org', url: 'https://vault.color111111.dpdns.org', group: 'Vault' },

    // 本地站点示例（需要服务处于运行状态时才显示正常）：
    // { id: 'my-blog', name: '我的博客', url: 'http://localhost:3001', group: '自建站点' },
  ],
};
