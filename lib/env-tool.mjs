/**
 * 御风 · 预提交本机信息
 *
 * 把 env-probe 的探测结果包装成一个模型可调用的工具，并把探测放到后台轮询。
 *
 * ## 为什么叫「预提交」
 *
 * 模型动手之前，先把它要面对的环境一次交代清楚。这与「先探后干」相反：
 * 探测成本被挪到进程启动时，模型第一步就能读到结论，不必一条命令一条命令试。
 *
 * ## 三段式刷新
 *
 *   启动时     → 异步完整探测（约 2.9 秒，不阻塞窗口）
 *   每 60 秒   → 只比指纹（约 10 ms），变了才重探
 *   工具调用时 → 指纹不符就立刻重探（覆盖「刚装完东西 59 秒内调工具」）
 *
 * 第三段是关键：没有它，用户装完 pnpm 立刻问模型，会拿到过期数据。
 *
 * ## 为什么不用 ctx.timer
 *
 * 御风原本就没有注入 timer，而这里只有一处轮询，用原生 setInterval
 * 放在 ctx.effect 的清理函数里更简单，且不增加插件之间的依赖面。
 */

// 不 import @deepseek-ai/dsh-tools：
//
//   · 第三方插件目录（profiles/desktop/plugins/dsh-toolbox）不在宿主 node_modules
//     的解析范围内，直接 import 会在插件加载时 ERR_MODULE_NOT_FOUND；
//   · 宿主 0.2.x 的 tools.register 接受**原生定义对象**，defineTool 只是
//     做了参数/输出校验的包装器，不是必需的；
//   · 同一 profile 里的 dsh-npu 就是这么做的（见其 index.js:2348）。
//     与它保持一致，才不会出现「装了某个插件就全崩」的连带故障。

import fs from 'node:fs';
import path from 'node:path';

/** 轮询间隔（毫秒）。指纹比对实测约 10 ms，60 秒一次开销可忽略。 */
const POLL_MS = 60000;

/**
 * 工具描述。
 *
 * 这段是模型**唯一**的选工具依据 —— 它比工具名重要得多。要点：
 *   ① 第一句就说清这是什么、什么时候用；
 *   ② 明确要求「别自己试探」，否则模型会跳过本工具直接开始敲命令；
 *   ③ 说明数据是缓存的、可能过期，给它一个自检的出口。
 */
const TOOL_DESC = [
  '读取预提交的本机信息。启动时已异步探测、每 60 秒后台刷新，调用即刻返回。\n',
  '内容：操作系统与 CPU、可用 shell（pwsh / PowerShell 5 / bash / WSL）、',
  '已装开发工具链及版本、.NET 运行时（Framework / Core 各版本，两套互不兼容）、',
  '系统 ANSI 代码页（非 UTF-8 时中文环境读写无 BOM 的 UTF-8 文件会乱码）、',
  'pwsh 的安装来源（Store / MSI，Store 版以 SYSTEM 运行会找不到）、',
  'CPU 核数与内存、各磁盘剩余空间、',
  '权限三要素（当前令牌是否提权 / 账户是否在 Administrators 组 / UAC 提权会不会弹窗）、',
  'GPU（有 NVIDIA 卡时由 nvidia-smi 给出型号/显存容量/驱动/计算能力/TCC 或 WDDM；',
  '其它显卡另列 gpu(other)）、包管理源与「源配了但不可达」的矛盾提示、',
  'Defender 实时扫描状态、代理配置（环境变量 / 系统代理 / WinHTTP 三处），',
  '以及 GitHub、HuggingFace、npm、PyPI、Go proxy 的连通性与「能否真正下完内容」两档实测。\n',
  '重要：本工具只报**静态事实**（装了什么、哪个版本、什么权限）。',
  '温度、显存占用、CPU 负载这类秒级变化的实时值一律不报 —— 它们会被误读成当前值。',
  '要这些请自己跑 nvidia-smi / Get-Counter 等。\n',
  'missing 行的判据是「PATH 里没找到可执行文件」，不等于「没装」',
  '（例如 pnpm 可能由 corepack 提供、cargo 可能在 %USERPROFILE%\\.cargo\\bin 而未入 PATH）。\n',
  '做法：凡是涉及「这台机器上有什么」「该用哪个 shell」「命令在不在」',
  '「能不能联网装包」「有没有权限写系统目录」的判断，先调用本工具；',
  '不要用 pwsh 逐条命令试探 —— Get-Command、--version、Test-Path 每一条都是一轮往返。\n',
  '注意：返回的 reach 行已给出不可达平台的替代方案（如 HF 走 hf-mirror、pip 换清华源），',
  '照做即可，不要自己去试一遍；reach 里标「可连但下载中断」的平台，',
  '下大文件要用 curl --retry 3 -C - 续传。',
  'detail=full 额外给出完整版本串、不在进程 PATH 里的目录',
  '（常解释「为什么命令找不到」）、逐平台连通/下载耗时与 missing 项的排查线索。',
].join('');

/**
 * 工作区技术栈标记。
 *
 * 只扫会话工作目录的**前两层**：实测 depth=2 约 27ms、depth=3 约 52ms，
 * 而超过两层的多半是备份目录/依赖缓存里的 package.json——本机就是如此，
 * 40 个命中里绝大多数来自 `backup-*`、`_frozen_*` 这些历史副本。
 *
 * 只报标记文件名，不解析内容：解析 package.json 的依赖需要读文件、
 * 判断框架版本，代价远大于收益，而且模型自己会读。
 *
 * @param {string} root 会话工作目录
 * @returns {string} 形如 `node(pnpm) / python / git(2 仓库)`；空串表示没认出来
 */
const STACK_MARKERS = {
  'package.json': 'node',
  // 包管理器单列：同一个 node 项目，模型该用 pnpm 还是 npm 会直接影响命令正确性
  'pnpm-workspace.yaml': 'pnpm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
  'tsconfig.json': 'ts',
  'vite.config.ts': 'vite',
  'next.config.js': 'next',
  'requirements.txt': 'python',
  'pyproject.toml': 'python',
  'setup.py': 'python',
  'Pipfile': 'python',
  'poetry.lock': 'python',
  'Cargo.toml': 'rust',
  'go.mod': 'go',
  'pom.xml': 'java-maven',
  'build.gradle': 'java-gradle',
  'CMakeLists.txt': 'cmake',
  'Makefile': 'make',
  'Dockerfile': 'docker',
};

/** 扫描时跳过的目录名：这些里面的标记文件不代表工作区本身。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv']);

/**
 * 扫出工作区的技术栈标记。
 *
 * @param {string} root 会话工作目录
 * @param {number} [maxDepth=2] 最大递归深度
 * @returns {string} 摘要；没有命中返回空串
 */
function describeStack(root, maxDepth = 2) {
  const found = new Set();
  let gitRepos = 0;

  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git') {
        gitRepos += 1;
        continue;
      }
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        const kind = STACK_MARKERS[e.name];
        if (kind) found.add(kind);
      } else if (e.isDirectory() && depth < maxDepth) {
        walk(full, depth + 1);
      }
    }
  };

  walk(root, 0);

  // 分组：语言是主，工具是它的括号内容。
  //   node + pnpm + ts + vite → "node(pnpm,ts,vite)"
  //   这样一行读完就知道「这是什么语言的项目、该用哪个包管理器、用的什么构建」。
  const GROUP_OF = {
    node: 'node', pnpm: 'node', yarn: 'node', npm: 'node', ts: 'node', vite: 'node', next: 'node',
    python: 'python',
    rust: 'rust',
    go: 'go',
    'java-maven': 'java', 'java-gradle': 'java',
    cmake: 'build', make: 'build',
    docker: 'docker',
  };
  const groups = new Map();
  for (const k of found) {
    const g = GROUP_OF[k] || k;
    if (!groups.has(g)) groups.set(g, new Set());
    groups.get(g).add(k);
  }
  const parts = [];
  for (const [g, subs] of groups) {
    const extra = [...subs].filter((s) => s !== g);
    parts.push(g + (extra.length ? '(' + extra.join(',') + ')' : ''));
  }
  if (gitRepos) parts.push('git×' + gitRepos);
  return parts.join(' / ');
}

/**
 * 装配本机信息工具。
 *
 * @param {object} params
 * @param {object} params.ctx        Cordis 上下文（需已注入 tools）
 * @param {object} params.probe      createEnvProbe 的返回值
 * @param {object} params.background 可选的 backgroundJob 适配层（没有也能跑）
 * @param {function} params.log      日志函数
 * @returns {{ dispose: function, ensure: function, start: function, stop: function }}
 */
export function installEnvTool({ ctx, probe, log, config, workingDirectory }) {
  let disposeTool = null;
  let timer = null;
  let disposed = false;

  /**
   * 工具定义。
   *
   * 用宿主原生的定义对象形态（parameters 走 JSON Schema 的 properties 字典，
   * output.schema 声明返回值），与同 profile 的 dsh-npu 保持一致。
   *
   * 为什么不套 defineTool：那个包装器来自 @deepseek-ai/dsh-tools，
   * 而第三方插件目录解析不到宿主的 node_modules，import 会直接让插件加载失败。
   * defineTool 只是加了一层参数/输出校验，代价与收益不成比例。
   */
  const TOOL_DEF = {
    name: 'local_env',
    description: TOOL_DESC,
    // parameters 是**原始 JSON Schema**，不是 defineTool 的 spec 字典。
    //
    // 区别：defineTool 的 parameters 写 { detail: { type:'string', required:true } }，
    // 由它自己编译成 JSON Schema；而 tools.register 直接把它当协议 schema 用，
    // 写成 spec 形态的话 detail 会被当成顶层关键字，工具就没有参数了
    // （模型会看到 parameters 里凭空多出 "detail" 这个非法字段）。
    // dsh-npu 的 npu_status 用的就是下面这种原始形态。
    parameters: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          enum: ['brief', 'full'],
          description: "详细程度：'brief'（默认，精简约 100 token）或 'full'（含完整版本串与不在进程 PATH 里的目录）",
        },
      },
      additionalProperties: false,
    },
    // output.schema 同样是原始 JSON Schema：`required` 是对象级的**数组**，
    // 不是写在每个属性里 —— 后者在标准 JSON Schema 里没有意义，会被忽略。
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '给模型阅读的本机信息正文' },
          sampledAt: { type: 'string', description: '本次数据采集时间（ISO 串）' },
          stale: { type: 'boolean', description: '数据是否可能过期（探测失败时为 true）' },
        },
        required: ['text', 'sampledAt', 'stale'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      // 显式传参优先；否则用面板配置的默认详细程度
      const detail = args && args.detail === 'full' ? 'full'
        : args && args.detail === 'brief' ? 'brief'
          : readConfig().detail;
      // 调用即校验：指纹变了就重探，保证「刚装完东西也能立刻看见」
      const data = await probe.ensure();
      const sampledAt = new Date(probe.cachedAt || Date.now()).toISOString();

      // 工作区目录必须**现取**，不能来自探测缓存：
      //   探测子进程拿到的是 DSH 主进程启动目录，而会话可以 cd 到别处。
      //   workingDirectory 服务给出的是这个会话真正的当前目录。
      let workspace = '';
      try {
        const agent = exec && exec.agent;
        // workingDirectory 由 index.js 从插件根 ctx 取好后传进来 ——
        // 这里的 ctx 是 tools 的 scoped context，实测取不到该服务。
        // 仍保留两条兜底路径，防止宿主把服务挂到别处。
        const wd = workingDirectory
          || ctx.workingDirectory
          || (typeof ctx.get === 'function' ? ctx.get('workingDirectory') : null);
        if (agent !== undefined && wd && typeof wd.ensure === 'function') {
          workspace = await wd.ensure(agent, exec.signal);
        }
      } catch (e) {
        log('工作目录读取失败（不影响其余信息）：' + ((e && e.message) || e));
      }
      // 技术栈标记：只在这个会话目录里扫，不猜别处
      let stack = '';
      if (workspace) {
        try {
          stack = describeStack(workspace);
        } catch (e) {
          log('技术栈扫描失败（不影响其余信息）：' + ((e && e.message) || e));
        }
      }

      return {
        text: probe.render(data, detail, { workspace, stack }),
        sampledAt,
        stale: data === null || probe.cachedAt === 0,
      };
    },
  };

  /**
   * 注册工具。
   *
   * 包 try/catch：注册失败只降级这一个功能，御风的划词转译必须照常可用。
   */
  /**
   * 注册工具（幂等）。
   *
   * 单独抽出来是因为面板可以随时开关这个功能 —— 关掉时要真的把工具
   * 从模型可见列表里摘掉，而不只是「不响应」。
   */
  function registerTool() {
    if (disposeTool) return true;
    try {
      if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
        log('tools 服务不可用：local_env 未注册（本机信息仍会在后台探测）');
        return false;
      }
      disposeTool = ctx.tools.register(TOOL_DEF);
      log('本机信息工具已注册（local_env）');
      return true;
    } catch (e) {
      log('本机信息工具注册失败（其余功能不受影响）：' + ((e && e.message) || e));
      disposeTool = null;
      return false;
    }
  }

  /** 注销工具。 */
  function unregisterTool() {
    if (!disposeTool) return;
    try { disposeTool(); } catch { /* ignore */ }
    disposeTool = null;
    log('本机信息工具已注销（local_env）');
  }

  registerTool();

  /**
   * 启动后台刷新。
   *
   * 先异步探一次（不 await，绝不阻塞 apply —— 否则窗口起来会卡 3 秒），
   * 再挂轮询。轮询只看指纹，变了才重探。
   */
  function start() {
    if (disposed) return;
    // 面板可以整体关掉这个功能：关了就把工具也摘掉、不轮询。
    if (!readConfig().enabled) {
      log('本机信息功能已在面板中关闭');
      unregisterTool();
      return;
    }
    registerTool();
    probe.ensure().catch((e) => log('启动探测失败：' + ((e && e.message) || e)));
    schedule(nextDelay());
  }

  /** 排下一次检查。用 setTimeout 链而不是 setInterval：让每次都能换间隔。 */
  function schedule(delay) {
    if (disposed) return;
    timer = setTimeout(async () => {
      timer = null;
      if (disposed) return;
      try {
        await probe.ensure();
      } catch (e) {
        log('轮询探测失败：' + ((e && e.message) || e));
      }
      schedule(nextDelay());
    }, delay);
    // unref：不要因为一个后台轮询而阻止进程退出
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /**
   * 读当前生效的配置。config 是个函数（不是对象），
   * 这样面板改了配置后不需要重启插件就能生效。
   *
   * @returns {{ enabled: boolean, pollMs: number, detail: string }}
   */
  function readConfig() {
    let c = {};
    try {
      c = (typeof config === 'function' ? config() : config) || {};
    } catch { /* ignore */ }
    return {
      enabled: c.enabled !== false,
      pollMs: Number(c.pollMs) > 0 ? Number(c.pollMs) : POLL_MS,
      detail: c.detail === 'full' ? 'full' : 'brief',
    };
  }

  /**
   * 下一次检查的间隔。
   *
   * 取面板配置的 pollMs（默认 60 秒）。曾考虑失焦退避到 5 分钟，
   * 但 DSH 没有向插件暴露「窗口是否在前台」的服务 —— 判断不了就别假装能判断。
   *
   * @returns {number} 毫秒
   */
  function nextDelay() {
    return readConfig().pollMs;
  }

  function stop() {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    unregisterTool();
  }

  /**
   * 面板改配置后调用：不重建整个插件，只按新配置调整。
   *
   * @param {object} next 新的 localEnv 配置
   */
  function applyConfig(next) {
    const cfgNext = next || {};
    const on = cfgNext.enabled !== false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (!on) {
      unregisterTool();
      log('本机信息功能已关闭（按面板配置）');
      return;
    }
    registerTool();
    // 间隔可能变了：重启一轮
    disposed = false;
    schedule(readConfig().pollMs);
    log('本机信息功能已启用，间隔 ' + readConfig().pollMs + 'ms');
  }

  return {
    start,
    stop,
    applyConfig,
    ensure: () => probe.ensure(),
    get registered() { return disposeTool !== null; },
  };
}
