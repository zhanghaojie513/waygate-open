/**
 * 原型图标兼容（v0.4.28）—— 这些图标被原型 views/*.js 引用（lucideSvg），
 * 但 web 组件已改用内联 SVG 或替换了图标，不再从 lucide-react import。
 * 同步器（sync-prototype-console.mjs）扫 web/src 的 lucide-react import 生成
 * icons.js —— 没有 import 的图标不会进 icons.js，原型调用 lucideSvg 就炸
 * （「未登记的图标：xxx」）。这里集中做一次 import，保证它们还在收录范围里。
 */
import { Database, Zap, Braces, Box, Terminal, Wrench, Code, Globe, Gauge, TrendingUp } from 'lucide-react';

/** 导出标记（防止 TS noUnusedLocals 报错，同时让同步器能扫到）。 */
export const _prototypeIconRefs = { Database, Zap, Braces, Box, Terminal, Wrench, Code, Globe, Gauge, TrendingUp };
