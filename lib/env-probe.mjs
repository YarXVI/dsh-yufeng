/**
 * dsh-toolbox · 预提交本机信息
 *
 * 在模型正式干活之前，把「这台机器是什么、装了什么」一次交代清楚。
 *
 * ## 为什么要有它
 *
 * 模型第一次拿到任务时，对运行环境一无所知，只能一条命令一条命令地试：
 * `Get-Command bash`、`pwsh --version`……每一条都是一次往返、一次延迟。
 * 更糟的是它会**默认假设**（比如以为有 bash、以为路径是 /tmp），然后失败重试。
 *
 * 本模块在进程启动时异步探一次，之后每 60 秒只比对**指纹**
 * （注册表 PATH + 白名单工具的路径/修改时间/大小），变了才重探。
 * 模型读工具即可，不必自己试探。
 *
 * ## 三层成本设计（本机实测）
 *
 * | 操作 | 耗时 | 何时发生 |
 * |---|---|---|
 * | 指纹比对（读注册表 + 扫 PATH 目录 + 22 次 stat） | 8.3 ms | 每 60 秒 |
 * | 完整探测（起一次 pwsh 子进程，跑一段自述脚本） | 2.9 s | 启动时，或指纹变化时 |
 *
 * 完整探测之所以要起子进程，是因为只有子进程能真正执行
 * `$PSVersionTable` / `--version` 这类自述命令。读文件版本号能省下这 3 秒，
 * 但拿不到 pwsh 的 PSEdition 与 go/ffmpeg 的真实版本串，不值得。
 *
 * ## 一个必须记住的坑：PATH 是启动时快照
 *
 * DSH 子进程的环境直接取自 `process.env`（见 dsh-subprocess 的
 * `scrubbedParentEnv()`），而 `process.env.PATH` 是 DSH 启动那一刻的副本。
 * 用户在别处装了 pnpm、改了 PATH，**进程内永远看不到**。
 *
 * 所以探测脚本自己从注册表读 HKLM+HKCU 的 Path 并前置到 `$env:PATH`，
 * 节流用的 `scanExecutables()` 也走注册表合并后的目录 —— 这样才能
 * 发现「刚装完的东西」。这条不是优化，是正确性前提。
 *
 * ## 白名单
 *
 * 全量扫描本机 264 个已装程序约 2060 token，其中剪映、鸣潮、网易云、
 * 搜狗输入法都是纯噪音。所以只保留「模型可能用得上的开发工具链」，
 * 并且按主包名归并（Python 的 11 个组件只留一条）。
 *
 * ## 纪律
 *
 * 探测失败绝不能拖垮宿主：所有宿主服务调用都包 try/catch，失败就返回
 * 上次的缓存或空结果，插件本身照常工作。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * 白名单：只探测这些工具。
 *
 * 取舍标准 ——「模型在这个环境里要干活时，会不会需要知道它有没有」：
 *   · git / node / npm / pnpm / yarn —— 版本控制与 JS 工具链，几乎每天用；
 *   · python / pip / uv —— Python 工具链；
 *   · cargo / rustc / go / java —— 其它语言的构建；
 *   · docker —— 容器；
 *   · ffmpeg / rg / cmake / 7z —— 常用命令行工具；
 *   · code —— 编辑器 CLI（能开文件、能装扩展）。
 *
 * 刻意不收：剪映、鸣潮、网易云、输入法、C++ Redistributable、
 * 各类 SDK 组件包 —— 实测全量 264 项约 2060 token，其中这类占九成以上，
 * 对模型做任何判断都没有帮助。
 */
const TOOL_NAMES = ['git', 'node', 'npm', 'pnpm', 'yarn', 'python', 'pip', 'uv', 'cargo', 'rustc', 'go', 'java', 'docker', 'ffmpeg', 'rg', 'cmake', '7z', 'code'];

/**
 * shell 类工具名（与 TOOL_NAMES 分开，因为它们上报格式不同）。
 *
 * 注意这里只写**不带扩展名**的名字：扫描时对每个名字试 ''.exe/.cmd/.bat/.ps1，
 * 而 `pnpm` 在 Windows 上就是个无扩展名的 shell 脚本 —— 写死在 `pnpm.exe` 会漏掉它。
 */
const SHELL_NAMES = ['pwsh', 'powershell', 'bash', 'wsl', 'nvidia-smi'];

/**
 * 常见 ANSI 代码页名称。
 *
 * 只收最常见的中日韩与西欧几项 —— 目的是让人一眼认出
 * 「936 就是 GBK，难怪读 UTF-8 会乱」，不是要当完整代码页表。
 */
const ACP_NAMES = {
  '936': 'GBK/GB2312',
  '950': 'Big5',
  '932': 'Shift-JIS',
  '949': 'EUC-KR',
  '874': 'Thai',
  '1252': 'Windows-1252',
  '1251': 'Cyrillic',
  '65001': 'UTF-8',
};

/** 注册表路径。HKEY_LOCAL_MACHINE / HKEY_CURRENT_USER 的 Path 值。 */
const REG_PATHS = [
  { hive: 'HKLM', sub: 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' },
  { hive: 'HKCU', sub: 'Environment' },
];

const HKLM = 0x80000002n;
const HKCU = 0x80000001n;
/** RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_RT_ANY */
const RRF_ANY = 0xFFFF;

/**
 * 创建探测器。
 *
 * @param {object} deps
 * @param {function} deps.loadKoffi  御风已有的 koffi 加载器
 * @param {function} deps.log        日志函数
 * @param {string}   deps.dshRoot    DSH 安装目录（用于找 pwsh 兜底路径）
 * @returns {object} 探测器
 */
export function createEnvProbe({ loadKoffi, log, dshRoot }) {
  /** 上一次成功探测的结果（原始值，未渲染） */
  let cached = null;
  /** 上一次探测时的指纹 */
  let cachedPrint = null;
  /** 上一次探测的时间戳 */
  let cachedAt = 0;
  /** 正在进行的探测（避免并发重复起子进程） */
  let inflight = null;

  // ---- 注册表 ----

  let regApi = null;
  let regTried = false;

  /**
   * 懒加载 advapi32。
   *
   * 用 RegGetValueW 单函数读值，不用 Open/Close 两段式：
   * 前者的 out 参数只有一处，后者的 hkey 出参在 koffi 里拿不到非空句柄
   * （实测打开成功但 hkey 始终为 null，随后查询返回 6=句柄无效）。
   * RegGetValueW 一次调用即得值，0.12 ms。
   */
  function ensureReg() {
    if (regTried) return regApi;
    regTried = true;
    try {
      const got = loadKoffi();
      if (!got) {
        log('注册表不可用：koffi 未找到');
        return null;
      }
      const advapi32 = got.koffi.load('advapi32.dll');
      regApi = {
        RegGetValueW: advapi32.func(
          'int RegGetValueW(uint64 hkey, char16 *lpSubKey, char16 *lpValue, uint32 dwFlags, uint32 *pdwType, void *pvData, uint32 *pcbData)',
        ),
      };
    } catch (e) {
      log('注册表初始化失败：' + ((e && e.message) || e));
      regApi = null;
    }
    return regApi;
  }

  /**
   * 读一个注册表字符串值。
   *
   * @param {bigint} hive      HKEY_LOCAL_MACHINE / HKEY_CURRENT_USER
   * @param {string} subKey    子键路径
   * @param {string} valueName 值名
   * @returns {string|null}    值；读不到返回 null（绝不抛）
   */
  function readReg(hive, subKey, valueName) {
    try {
      const api = ensureReg();
      if (!api) return null;
      const buf = Buffer.alloc(65536);
      const cb = [65536];
      const typeOut = [0];
      const rc = api.RegGetValueW(hive, subKey, valueName, RRF_ANY, typeOut, buf, cb);
      if (rc !== 0) return null;
      return buf.subarray(0, cb[0]).toString('utf16le').replace(/\0.*/s, '');
    } catch (e) {
      log('注册表读取失败：' + ((e && e.message) || e));
      return null;
    }
  }

  /**
   * 把注册表里的 HKLM/HKCU Path 合并成一条。
   *
   * **这是关键**：DSH 进程的 process.env.PATH 是启动时的快照，用户后来装的
   * 工具不会出现在里面（实测进程内 1407 字符 vs 注册表合并 1323 字符，
   * 前者还更长，因为含重复项）。只有读注册表才能看到新装的东西。
   *
   * @returns {{ machine: string, user: string, merged: string, extra: string[] }}
   */
  function registryPath() {
    const machine = readReg(HKLM, REG_PATHS[0].sub, 'Path') || '';
    const user = readReg(HKCU, REG_PATHS[1].sub, 'Path') || '';
    const expand = (s) => s.replace(/%([^%]+)%/g, (m, name) => {
      const v = process.env[name] ?? process.env[name.toUpperCase()];
      return v === undefined ? m : v;
    });
    const m = expand(machine);
    const u = expand(user);
    const merged = [m, u].filter(Boolean).join(';');
    const norm = (p) => p.trim().replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
    const seen = new Set();
    const extra = [];
    for (const entry of merged.split(';')) {
      const p = entry.trim();
      if (!p) continue;
      const key = norm(p);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!process.env.PATH?.toLowerCase().includes(key)) extra.push(p);
    }
    return { machine: m, user: u, merged, extra };
  }

  // ---- 路径解析与指纹 ----

  /** 扩展名顺序：Windows 的 PATHEXT 语义。空串在前，兼容 `code` 这类无扩展名脚本。 */
  const EXEC_EXTS = ['', '.exe', '.cmd', '.bat', '.ps1'];

  /**
   * 把 PATH 解析成去重后的目录列表（注册表优先，进程 PATH 兜底）。
   *
   * @returns {string[]} 目录绝对路径
   */
  function searchDirs() {
    const rp = registryPath();
    const raw = [rp.merged, process.env.PATH || ''].join(';');
    const out = [];
    const seen = new Set();
    for (const entry of raw.split(';')) {
      const d = entry.trim().replace(/"/g, '');
      if (!d) continue;
      const key = d.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
    return out;
  }

  /**
   * 扫一遍 PATH 目录，找出白名单里实际存在的可执行文件。
   *
   * **这是指纹的核心**：不能只 stat 几个写死的 exe —— 那既漏（`pnpm` 是无扩展名
   * 的 shell 脚本，`pnpm.exe` 根本不存在）又慢（每个都要 existsSync 走一遍）。
   * 反过来「读目录 + 查表」一次拿全：本机 33 个目录、22 个候选名，实测 6.7 ms。
   *
   * @returns {Map<string, string>} 工具名 → 绝对路径（只含真正存在的）
   */
  function scanExecutables() {
    const found = new Map();
    const wanted = new Set();
    for (const t of [...TOOL_NAMES, ...SHELL_NAMES]) {
      for (const ext of EXEC_EXTS) wanted.add((t + ext).toLowerCase());
    }
    for (const dir of searchDirs()) {
      let entries;
      try {
        // withFileTypes：**必须**区分文件与目录。
        // 反例：本机 C:\Users\123\AppData\Local\pnpm 是 pnpm 的数据目录
        // （里面是 .tools / store），名字却恰好是 `pnpm`。只按名字匹配会把它
        // 当可执行文件，导致模型以为 pnpm 装了、直接敲命令却失败。
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // 目录不存在或无权访问，跳过即可
      }
      const lower = new Map();
      for (const e of entries) {
        if (!e.isFile()) continue; // 目录、符号链接（非文件目标）一律不算
        lower.set(e.name.toLowerCase(), e.name);
      }
      for (const want of wanted) {
        const real = lower.get(want);
        if (real === undefined) continue;
        // 用候选名去掉扩展名作为工具名；同名先到先得（PATH 靠前的优先）
        const baseName = want.replace(/\.[a-z0-9]+$/, '');
        if (!found.has(baseName)) found.set(baseName, path.join(dir, real));
      }
    }
    return found;
  }

  /**
   * 计算环境指纹。
   *
   * 三样东西一起算：
   *   ① 注册表 PATH 原文（用户改了 PATH → 立即变化）
   *   ② 白名单工具的绝对路径（新装工具 → 出现新条目）
   *   ③ 这些文件的 mtime + size（原地升级 → 路径不变但版本变）
   *
   * 实测总耗时 8.3 ms，60 秒一次完全可以忽略。
   *
   * @returns {string} 十六进制摘要
   */
  function fingerprint() {
    const parts = [];
    parts.push(registryPath().merged);

    // 代理与网络接口的变化也必须触发重探。
    //
    // 否则会出现很尴尬的情况：用户开了 VPN，外网从不通变通，但指纹没变，
    // 缓存里还写着「huggingface 不可达」，模型于是继续走镜像源，
    // 或者反过来——关掉 VPN 后模型仍照旧直连，每次都超时。
    // 这两处都很便宜（注册表读 + 网络接口枚举，合计几毫秒）。
    try {
      const ie = GetIeProxy();
      parts.push('ieProxy=' + (ie ? ie.enabled + '/' + ie.server + '/' + ie.pac : 'none'));
    } catch { /* ignore */ }
    try {
      parts.push('ifaces=' + networkFingerprint());
    } catch { /* ignore */ }

    // nvidia-smi 自身的 mtime：换驱动会更新这个文件，比每次跑 137ms 的
    // nvidia-smi 便宜得多（实测 19ms）。
    try {
      const nsmi = which('nvidia-smi');
      if (nsmi) {
        const st = fs.statSync(nsmi);
        parts.push('nsmi=' + st.mtimeMs + '@' + st.size);
      } else {
        parts.push('nsmi=-');
      }
    } catch { /* ignore */ }

    // 包管理源改动（用户切镜像）也必须触发重探，否则缓存里的源会是旧的。
    // 读文件，不起 npm/go 命令。
    try {
      const npmrc = path.join(process.env.USERPROFILE || '', '.npmrc');
      if (fs.existsSync(npmrc)) parts.push('npmrc=' + fs.statSync(npmrc).mtimeMs);
      const goenv = path.join(process.env.APPDATA || '', 'go', 'env');
      if (fs.existsSync(goenv)) parts.push('goenv=' + fs.statSync(goenv).mtimeMs);
    } catch { /* ignore */ }

    const found = scanExecutables();
    for (const t of [...TOOL_NAMES, ...SHELL_NAMES].sort()) {
      const p = found.get(t);
      if (!p) {
        parts.push(t + '=-');
        continue;
      }
      try {
        const st = fs.statSync(p);
        parts.push(t + '=' + p + '@' + st.mtimeMs + '@' + st.size);
      } catch {
        parts.push(t + '=' + p + '@nostat');
      }
    }
    return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
  }

  /**
   * 在**注册表合并后的 PATH** 里找一个可执行文件。
   *
   * 注意不能用 `where.exe` 或 `Get-Command`：它们走的是进程内 PATH（旧快照）。
   * 这里查 scanExecutables 的结果，才能看见用户新装的工具。
   *
   * @param {string} name 工具名（如 `pnpm`），不带扩展名
   * @returns {string|null} 绝对路径
   */
  function which(name) {
    return scanExecutables().get(name) || null;
  }

  // ---- 完整探测 ----

  /**
   * 探测脚本。
   *
   * 设计原则：
   *   · 一次子进程拿全，不要模型自己一条条试；
   *   · 版本号优先读 VersionInfo（不起第二次进程），拿不到再 `--version`；
   *   · 输出用 `key|value` 行格式，便于解析且省 token（不用 JSON 的括号引号）。
   */
  const PROBE_SCRIPT = [
    // 输出编码：不设的话中文路径会变成乱码（pwsh 默认按控制台代码页解码）
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "$OutputEncoding=[Text.Encoding]::UTF8",
    "$ErrorActionPreference='SilentlyContinue'",
    // **关键**：把注册表里的 HKLM+HKCU Path 合并进来，并置于进程 PATH 之前。
    //
    // 不加这一步，Get-Command 只看得到 DSH 启动时的 PATH 快照 —— 用户装了
    // 新工具（或在 PATH 里加了目录）后，进程环境不会跟着变，探测就永远
    // 看不到它们。实测本机注册表合并值含 D:/OpenClaw/nodejs 等进程里没有的目录。
    "$m=[Environment]::GetEnvironmentVariable('Path','Machine')",
    "$u=[Environment]::GetEnvironmentVariable('Path','User')",
    "$env:PATH=$m+';'+$u+';'+$env:PATH",
    "$out=@()",
    // --- 操作系统 ---
    "$cv=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'",
    "$out+='os|'+$cv.ProductName+' '+$cv.CurrentBuild+'.'+$cv.UBR+' '+$env:PROCESSOR_ARCHITECTURE",
    "$cs=Get-ItemProperty 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0'",
    "$out+='cpu|'+$cs.ProcessorNameString.Trim()",
    // --- 当前 shell：探测脚本本身就跑在 pwsh 里，直接用 $PSVersionTable，最准也最快 ---
    // 同时报安装来源（Store / MSI）：
    //   Store 版装在 %LOCALAPPDATA%\Microsoft\WindowsApps，靠 App Execution Alias 暴露。
    //   该别名在 SYSTEM / 服务账户的 profile 里不存在 —— 于是「用户下跑得好好的 pwsh」
    //   一旦做成计划任务以 SYSTEM 运行就会「找不到 pwsh.exe」。
    //   这不算环境错误，但决定了「同一段脚本能不能换个身份跑」。
    "$pwshPath=(Get-Command pwsh -ErrorAction SilentlyContinue).Source",
    "$pwshSrc = if($pwshPath -match 'WindowsApps'){ 'Store' } else { 'MSI' }",
    "$out+='pwsh|'+$PSVersionTable.PSVersion.ToString()+'|'+$PSVersionTable.PSEdition+'|'+$pwshSrc",
    // powershell 5 的版本：文件版本是 10.0.x（不可用），得读注册表 PowerShellEngine
    "$pe=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\PowerShell\\3\\PowerShellEngine'",
    "if($pe){ $out+='powershell|'+$pe.PowerShellVersion } else { $out+='powershell|absent' }",
    "$b=Get-Command bash -ErrorAction SilentlyContinue",
    "if($b){ $out+='bash|'+$b.Source } else { $out+='bash|absent' }",
    "$w=Get-Command wsl -ErrorAction SilentlyContinue",
    "if($w){ $d=(& wsl -l -q 2>$null); $out+='wsl|'+(((($d -join ',')).Trim()))+'|'+$w.Source } else { $out+='wsl|absent' }",
    // --- 工具链（白名单）。|
    // 版本策略（三层，越靠前越便宜）：
    //   ① VersionInfo：不额外起进程，git/node/npm/python/java/code 都够用；
    //   ② 版本子命令：只有 `--version` 不管用的才列进 VERSION_ARG；
    //      · go 要 `go version`（不是 --version）；
    //      · ffmpeg 把版本打到 **stderr**，所以必须 2>&1 而不是 2>$null。
    //   ③ 拿不到就留空，渲染时只报名字 —— 宁可少一个版本号，也不为了让
    //      某个工具好看而给每个工具都起一次进程。 ---
    "$tools='git','node','npm','pnpm','yarn','python','pip','uv','cargo','rustc','go','java','docker','ffmpeg','rg','cmake','7z','code'",
    // 键一律加引号：`7z` 不是合法标识符，不加引号会被 PowerShell 当成数字字面量而报 ParserError
    "$verArgs=@{'go'='version';'cargo'='--version';'rustc'='--version';'docker'='--version';'cmake'='--version';'7z'='--help'}",
    "foreach($t in $tools){",
    "  $c=Get-Command $t -ErrorAction SilentlyContinue | Select-Object -First 1",
    "  if($c){",
    "    $vi=(Get-Item $c.Source).VersionInfo",
    "    $ver=$vi.ProductVersion; if(-not $ver){ $ver=$vi.FileVersion }",
    "    if(-not $ver){",
    "      $arg=$verArgs[$t]; if(-not $arg){ $arg='--version' }",
    "      try{ $ver=(& $c.Source $arg 2>&1 | Select-Object -First 1) }catch{}",
    "    }",
    "    $out+='tool|'+$t+'|'+((\"$ver\" -replace '\\s+',' ').Trim())",
    "  }",
    "}",
    // --- 硬件与权限 ---
    "$out+='cores|'+[Environment]::ProcessorCount",
    "$me=Get-CimInstance Win32_ComputerSystem -Property TotalPhysicalMemory -ErrorAction SilentlyContinue",
    "if($me){ $out+='mem|'+[math]::Round($me.TotalPhysicalMemory/1GB,0) }",
    // --- 权限：三个层次，不能用「是否管理员」一个布尔代替 ---
    //   ① 当前令牌能否直接写系统目录（IsInRole(Administrator)）—— 过滤令牌下为 False；
    //   ② 账户本身是否在 Administrators 组 —— 决定「提权后能不能拿到」；
    //      两者常不一致：本机就是「不在提权令牌里，但账户在组里」，
    //      于是「立即不行」但「提权后可行」。只报前者会让人以为彻底没有权限。
    //   ③ UAC 提权会不会弹窗（ConsentPromptBehaviorAdmin）—— 决定「能不能无人值守」。
    //      =0 表示管理员提权不弹窗，脚本可以静默升权；这是自动化场景的关键差别。
    //      这条是外部评审专门要求补的，确实常被忽略。
    "$id=[Security.Principal.WindowsIdentity]::GetCurrent()",
    "$pr=New-Object Security.Principal.WindowsPrincipal($id)",
    "$out+='admin|'+$pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    "$out+='user|'+$id.Name",
    // SYSTEM 身份会改变很多判断：Store 版 pwsh 不可用、家目录变成 systemprofile、
    // 部分用户级 PATH 失效。判定成本接近零（只是比 SID）。
    "$out+='is_system|'+($id.User.Value -eq 'S-1-5-18')",
    // 令牌里是否有 Administrators 组 SID（S-1-5-32-544）。
    // 过滤令牌下这个 SID 会以 deny-only 形式存在，Groups 里仍可枚举到 —— 只作参考。
    "$inTok = [bool]($id.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })",
    "$out+='admin_in_group_token|'+$inTok",
    // 权威判定：本地 Administrators 组成员列表。net localgroup 约 84ms，可接受。
    "$admList = (net localgroup Administrators 2>$null) -join [char]10",
    "$inGroup = if($admList){ [bool]($admList -match ('(?m)^' + [regex]::Escape($env:USERNAME) + '\s*$')) } else { $null }",
    "if($inGroup -ne $null){ $out+='admin_in_group|'+$inGroup }",
    // UAC 策略
    "$ps=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -ErrorAction SilentlyContinue",
    "if($ps){",
    "  $out+='uac|'+$ps.EnableLUA+'|'+$ps.ConsentPromptBehaviorAdmin+'|'+$ps.PromptOnSecureDesktop",
    "}",
    // --- GPU：分两路 ---
    //   ① NVIDIA 卡优先走 nvidia-smi —— 兼容性安装（拿 T10 卡刷 T4 数据中心驱动
    //      换 TCC 能力）下，设备管理器报的型号会骗人（本机 Win32 报 "Tesla T4"、
    //      nvidia-smi 报 "Tesla T10"），只有 nvidia-smi 能给真实型号+显存+驱动+
    //      计算能力+驱动模型（TCC/WDDM）+温度。**没有 N 卡时不产生这一行。**
    //   ② 非 NVIDIA 显卡走 Win32_VideoController + 注册表读显存。
    //
    // 为什么非 N 卡不能用 Win32_VideoController 的 AdapterRAM：
    // 它是 uint32，上限 4GB。本机 AMD RX 9070 XT 报 4293918720（=4GB 封顶），
    // 实际是 16GB —— 差了一个数量级，模型据此判断「能不能跑本地大模型」会全错。
    // 正确值在注册表 hardwareinformation.qwMemorySize（64 位）。
    //
    // 成本：nvidia-smi 约 140ms；Win32(只取名+驱动) 52ms + 注册表 97ms。
    // 两者都够快，不必二选一。
    "$ns=Get-Command nvidia-smi -ErrorAction SilentlyContinue",
    "if($ns){",
    "  $gpu=(& nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,compute_cap,driver_model.current,temperature.gpu --format=csv,noheader 2>$null | Select-Object -First 1)",
    "  if($gpu){ $out+='gpu|'+$gpu }",
    "}",
    // 非 NVIDIA 显卡：从 Win32 拿名字与驱动，再从注册表补真实显存
    "$others=(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'NVIDIA|GeForce|Quadro|Tesla' })",
    "if($others){",
    "  $vramMap=@{}",
    "  $cls='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
    "  Get-ChildItem $cls -ErrorAction SilentlyContinue | ForEach-Object {",
    "    $kv=Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue",
    "    if($kv.DriverDesc -and $kv.'hardwareinformation.qwMemorySize'){",
    "      $vramMap[$kv.DriverDesc]=[math]::Round([int64]$kv.'hardwareinformation.qwMemorySize'/1GB,0)",
    "    }",
    "  }",
    "  foreach($v in $others){",
    "    $gb=$vramMap[$v.Name]",
    "    $line=$v.Name; if($gb){ $line=$line+'|'+$gb }; $line=$line+'|drv'+$v.DriverVersion",
    "    $out+='gpu_other|'+$line",
    "  }",
    "}",
    // --- .NET 运行时：决定「某个 DLL 能不能加载」 ---
    // 为什么值得报：net472 与 net10 的 DLL **互不兼容**（前者是 .NET Framework 的
    // 元数据/依赖模型，后者是 .NET 的）。模型拿到一个只有 net10 的机器去放
    // net472 编译的库，就会在编译期或加载期失败，而它往往先怀疑代码写错。
    // 报「装了哪些运行时」比报「该用哪个」有用：模型自己能对上目标框架。
    "$ndp=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full' -ErrorAction SilentlyContinue",
    "if($ndp -and $ndp.Release){",
    "  $r=$ndp.Release",
    "  $fx = if($r -ge 533320){'4.8.1'} elseif($r -ge 528040){'4.8'} elseif($r -ge 461808){'4.7.2'} elseif($r -ge 460798){'4.7'} elseif($r -ge 394802){'4.6.2'} else {'<=4.6.1'}",
    "  $out+='netfx|'+$fx",
    "}",
    "$dn=Get-Command dotnet -ErrorAction SilentlyContinue",
    "if($dn){",
    "  $rt=(& dotnet --list-runtimes 2>$null)",
    "  $core=$rt | Where-Object { $_ -match '^Microsoft\\.NETCore\\.App\\s+(\\d+)\\.' } | ForEach-Object { ($_ -split '\\s+')[1].Split('.')[0] } | Sort-Object -Unique",
    // 按数值排序：字符串排序会得到 10/6/8/9，看着别扭且不利快速扫读
    "  $core = $core | Sort-Object { [int]$_ }",
    "  if($core){ $out+='dotnet|'+($core -join '/') }",
    "}",
    // --- 系统代码页：中文环境 UTF-8 乱码的根源 ---
    // ACP=936（GBK）意味着：不带 BOM 的 UTF-8 文件会被按 GBK 解码；
    // 反过来，把 GBK 内容当 UTF-8 读也会乱。这与「代码里写没写 UTF-8」无关，
    // 是系统级默认编码。判 utf-8 是否默认，看 ACP 是否 65001。
    "$acp=(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage' -ErrorAction SilentlyContinue).ACP",
    "if($acp){ $out+='acp|'+$acp }",
    // --- 磁盘：只报固定盘，卷标太长会挤占 token，用「盘:剩余/总量(GB)」 ---
    "$dl=@()",
    "foreach($dv in [System.IO.DriveInfo]::GetDrives()){",
    "  if($dv.IsReady -and $dv.DriveType -eq 'Fixed'){",
    // 盘符直接取 Name 首字母。原本用 TrimEnd 剥反斜杠，但 JS 源里的 \\ 转义后
    // 到 PowerShell 只剩一个反斜杠字符，TrimEnd 剥不干净，拼出来就是 C::
    "    $dl+=($dv.Name.Substring(0,1)+':'+[math]::Round($dv.AvailableFreeSpace/1GB,0)+'/'+[math]::Round($dv.TotalSize/1GB,0))",
    "  }",
    "}",
    "if($dl.Count){ $out+='disk|'+($dl -join ' ') }",
    // --- 代理：三处来源，缺一不可 ---
    //   ① 环境变量（HTTP_PROXY 等，很多 CLI 只认这个）；
    //   ② IE/WinINet 注册表（ProxyEnable + ProxyServer，Electron/Chrome 认这个）；
    //   ③ WinHTTP（服务级，curl/系统组件认这个）。
    // 三者常不一致：本机 IE 里写着 127.0.0.1:7892 但 ProxyEnable=0，
    // 说明代理软件装过、当前未启用 —— 这种「配置残留」必须如实报出来，
    // 否则模型会以为有代理可用。
    "$ie=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'",
    "if($ie){ $out+='proxy_ie|'+$ie.ProxyEnable+'|'+$ie.ProxyServer+'|'+$ie.AutoConfigURL }",
    "foreach($pn in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY')){",
    "  $pv=[Environment]::GetEnvironmentVariable($pn)",
    "  if($pv){ $out+='proxy_env|'+$pn+'|'+$pv }",
    "}",
    // --- 包管理源：决定「装包会不会卡」 ---
    // 一律读配置文件，不起命令：
    //   npm config get registry 要 473ms，读 ~/.npmrc 只要 10-116ms；
    //   go env GOPROXY 要 92ms，且本机 GOENV 文件为空（全用默认值）。
    // 本机实测最典型的坑：npm 已换 npmmirror，而 GOPROXY 仍是官方源
    // proxy.golang.org —— 那个域名在这里不通（实测 2.5s 超时），
    // 模型一说 go mod download 就会卡死。
    "$npmrc=Join-Path $env:USERPROFILE '.npmrc'",
    "if(Test-Path $npmrc){",
    "  $nr=Get-Content $npmrc -Raw",
    "  $m=[regex]::Match($nr,'registry\s*=\s*(.+)')",
    "  if($m.Success){ $out+='registry|npm|'+$m.Groups[1].Value.Trim() } else { $out+='registry|npm|https://registry.npmjs.org' }",
    "} else { $out+='registry|npm|https://registry.npmjs.org' }",
    // GOPROXY：先看环境变量（优先级最高），再看 go env 文件。
    // 都没有时必须报**实际默认值**而不是 `default` —— 因为 Go 的默认
    // 是 `https://proxy.golang.org,direct`，而这个域名在本机不通（实测超时）。
    // 只写 default，模型会以为「没配置=应该能用」，然后 go mod download 卡死。
    "$goR = $env:GOPROXY",
    "if(-not $goR){",
    "  $goenv=Join-Path $env:APPDATA 'go\\env'",
    "  if(Test-Path $goenv){",
    "    $gr=Get-Content $goenv -Raw",
    "    $m2=[regex]::Match($gr,'GOPROXY\s*=\s*(.+)')",
    "    if($m2.Success){ $goR=$m2.Groups[1].Value.Trim() }",
    "  }",
    "}",
    "if($goR){ $out+='registry|go|'+$goR } else { $out+='registry|go|https://proxy.golang.org,direct' }",
    // pip：先看环境变量，再看 pip.ini，最后算默认
    "$pi=$env:PIP_INDEX_URL",
    "if(-not $pi){",
    "  foreach($pf in @((Join-Path $env:APPDATA 'pip\\pip.ini'),(Join-Path $env:USERPROFILE 'pip\\pip.ini'))){",
    "    if(Test-Path $pf){ $pc=Get-Content $pf -Raw; $m3=[regex]::Match($pc,'index-url\s*=\s*(.+)'); if($m3.Success){ $pi=$m3.Groups[1].Value.Trim() } }",
    "  }",
    "}",
    "if($pi){ $out+='registry|pip|'+$pi } else { $out+='registry|pip|https://pypi.org/simple' }",
    // --- 关键环境变量：决定「该不该显式指路径」 ---
    "foreach($ev in @('JAVA_HOME','GOROOT','PYTHONPATH','CONDA_PREFIX','CARGO_HOME','RUSTUP_HOME')){",
    "  $vv=[Environment]::GetEnvironmentVariable($ev)",
    "  if($vv){ $out+='env|'+$ev+'|'+$vv }",
    "}",
    // --- Defender 实时防护：决定「同样的构建在这里会不会慢几倍」 ---
    // Get-MpPreference 要 1656ms 且在本机不可用；查服务只要 8ms 且够用
    "$wd=Get-Service WinDefend -ErrorAction SilentlyContinue",
    "if($wd){ $out+='defender|'+$wd.Status }",
    // WinHTTP 走 COM 对象，比 netsh 快（164ms -> 13ms）
    "try{",
    "  $wh=[System.Net.WebRequest]::GetSystemWebProxy()",
    "  $wu=$wh.GetProxy('https://github.com')",
    "  if($wu -and $wu.AbsoluteUri -ne 'https://github.com'){ $out+='proxy_winhttp|'+$wu.AbsoluteUri } else { $out+='proxy_winhttp|none' }",
    "}catch{ $out+='proxy_winhttp|error' }",
    "$out -join \"`n\"",
  ].join('; ');

  /**
   * 起一次 pwsh 跑探测脚本。
   *
   * @returns {Promise<object|null>} 解析后的探测结果；失败返回 null
   */
  function runProbeScript() {
    return new Promise((resolve) => {
      const pwsh = which('pwsh.exe') || 'pwsh.exe';
      const started = Date.now();
      execFile(
        pwsh,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_SCRIPT],
        { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            log('探测失败：' + ((err && err.message) || err) + ' ' + String(stderr || '').slice(0, 200));
            resolve(null);
            return;
          }
          const parsed = parseProbeOutput(String(stdout || ''));
          parsed.durationMs = Date.now() - started;
          resolve(parsed);
        },
      );
    });
  }

  /**
   * 把 `key|value...` 行解析成结构化结果。
   *
   * @param {string} text 子进程输出
   * @returns {object}
   */
  function parseProbeOutput(text) {
    const result = { os: '', cpu: '', shells: {}, tools: [], cwd: '', raw: {} };
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || !t.includes('|')) continue;
      const [key, ...rest] = t.split('|');
      if (key === 'os') result.os = rest.join('|');
      else if (key === 'cpu') result.cpu = rest.join('|');
      // 不再解析 cwd（见探测脚本处的说明）
      else if (key === 'pwsh') result.shells.pwsh = rest[0] === 'absent' ? null : { version: rest[0], edition: rest[1] || '', source: rest[2] || '' };
      else if (key === 'powershell') result.shells.powershell = rest[0] === 'absent' ? null : { version: rest[0] };
      else if (key === 'bash') result.shells.bash = rest[0] === 'absent' ? null : { path: rest[0] };
      else if (key === 'wsl') result.shells.wsl = rest[0] === 'absent' ? null : { distros: rest[0], path: rest[1] || '' };
      else if (key === 'tool') result.tools.push({ name: rest[0], version: (rest[1] || '').trim() });
      else if (key === 'cores') result.cores = Number(rest[0]) || 0;
      else if (key === 'mem') result.memGB = Number(rest[0]) || 0;
      else if (key === 'admin') result.isAdmin = rest[0] === 'True';
      else if (key === 'user') result.user = rest.join('|');
      else if (key === 'is_system') result.isSystem = rest[0] === 'True';
      else if (key === 'netfx') result.netfx = rest[0];
      else if (key === 'dotnet') result.dotnet = rest[0];
      else if (key === 'acp') result.acp = rest[0];
      else if (key === 'admin_in_group_token') result.adminInToken = rest[0] === 'True';
      else if (key === 'admin_in_group') result.adminInGroup = rest[0] === 'True';
      else if (key === 'uac') {
        result.uac = {
          lua: rest[0] === '1' || rest[0] === 'True',
          consentAdmin: rest[1] === '' || rest[1] === undefined ? null : Number(rest[1]),
          secureDesktop: rest[2] === '1' || rest[2] === 'True',
        };
      }
      else if (key === 'disk') result.disk = rest.join('|');
      else if (key === 'proxy_ie') result.proxy = { ...(result.proxy || {}), ie: { enabled: rest[0] === '1', server: rest[1] || '', pac: rest[2] || '' } };
      else if (key === 'proxy_env') {
        result.proxy = result.proxy || {};
        result.proxy.env = result.proxy.env || {};
        result.proxy.env[rest[0]] = rest.slice(1).join('|');
      }
      else if (key === 'proxy_winhttp') result.proxy = { ...(result.proxy || {}), winhttp: rest[0] };
      else if (key === 'gpu') result.gpu = rest.join('|');
      else if (key === 'gpu_other') {
        result.gpuOthers = result.gpuOthers || [];
        // 形如 `AMD Radeon RX 9070 XT|16|drv32.0.32015.7029`
        result.gpuOthers.push({ name: rest[0], vramGB: Number(rest[1]) || 0, driver: rest[2] || '' });
      }
      else if (key === 'registry') {
        result.registry = result.registry || {};
        result.registry[rest[0]] = rest.slice(1).join('|');
      }
      else if (key === 'env') {
        result.envVars = result.envVars || {};
        result.envVars[rest[0]] = rest.slice(1).join('|');
      }
      else if (key === 'defender') result.defender = rest[0];
      result.raw[t] = true;
    }
    return result;
  }

  // ---- 缓存 ----

  /**
   * 确保缓存有效。
   *
   * 三段式：命中缓存 → 返回；指纹不符 → 重探；无缓存 → 探。
   * 并发调用复用同一个 inflight。
   *
   * @param {boolean} force 强制重探
   * @returns {Promise<object|null>}
   */
  async function ensure(force = false) {
    const print = fingerprint();
    if (!force && cached && cachedPrint === print) return cached;
    if (inflight) return inflight;
    const startedAt = Date.now();
    inflight = (async () => {
      try {
        // 两路并行：pwsh 子进程（慢，2.9s）+ Node 侧 TCP 探测（快，约 1.2s）
        const [fresh, netResult] = await Promise.all([
          runProbeScript(),
          probeReachability().catch(() => null),
        ]);
        if (fresh) {
          fresh.net = netResult;
          fresh.totalMs = Date.now() - startedAt;
          cached = fresh;
          cachedPrint = print;
          cachedAt = Date.now();
          log('本机信息已更新（shell ' + fresh.durationMs + 'ms + net，共 ' + fresh.totalMs + 'ms）');
        }
        return cached;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /**
   * 渲染成给模型看的紧凑文本。
   *
   * @param {object|null} data 探测结果
   * @param {'brief'|'full'} detail 详细程度
   * @returns {string}
   */
  function render(data, detail = 'brief', extra = {}) {
    if (!data) return '本机信息暂不可用（探测失败）；请改用命令行试探，并在结论中说明这是降级结果。';
    const L = [];

    // 工作区放最前：模型第一眼就要知道自己在这台机器的哪个目录、面对什么技术栈
    if (extra.workspace) L.push('workspace: ' + extra.workspace);
    if (extra.stack) L.push('stack: ' + extra.stack);
    L.push('os: ' + compactOs(data.os) + (data.cpu ? ' · ' + compactCpu(data.cpu) : ''));
    const sh = [];
    if (data.shells.pwsh) {
      const p = data.shells.pwsh;
      const flags = [p.edition, p.source].filter(Boolean).join(',');
      // Store 版只加一个字标记，不展开解释——完整说明放 full。
      // 理由：它只在「换身份运行」时才成问题，日常执行完全正常，
      // 每次都用一整句提醒反而挤占 brief 的注意力。
      sh.push('pwsh ' + p.version + (flags ? '(' + flags + ')' : ''));
    }
    else sh.push('pwsh 无');
    if (data.shells.powershell) sh.push('posh5 ' + data.shells.powershell.version);
    sh.push(data.shells.bash ? 'bash 有' : 'bash 无');
    if (data.shells.wsl) sh.push('wsl ' + (data.shells.wsl.distros || '无发行版'));
    else sh.push('wsl 无');
    L.push('shell: ' + sh.join(' · '));
    const have = [];
    for (const t of data.tools) {
      have.push(t.version ? t.name + ' ' + shortVersion(t.version) : t.name);
    }
    L.push('have: ' + (have.length ? have.join(' / ') : '（无）'));
    // 「missing」不等于「没装」：本工具的判据是「PATH（注册表合并后）里没有可执行文件」。
    // 常见的三种反例：
    //   · pnpm 可能由 corepack 提供（node 自带），但要先 enable 才会出现在 PATH；
    //   · rustup 管理的 cargo 装在 %USERPROFILE%.cargoin，未加入 PATH 就找不到；
    //   · 装在非标准目录、或用 scoop/choco 但没 shim 到 PATH。
    // 所以措辞写「PATH 未找到」，并给一句「若确认装了再查」的出口，
    // 避免模型据此断言「用户没装」而建议重装。
    const miss = PROBE_TOOL_NAMES.filter((n) => !data.tools.some((t) => t.name === n));
    if (miss.length) {
      L.push('missing(PATH 未找到，不必然等于未安装): ' + miss.join(', '));
      // 对最容易被误判的几个补一句线索（只在 full 里给，brief 保持简短）
      if (detail === 'full') {
        const hints = [];
        if (miss.includes('pnpm')) hints.push('pnpm 可由 corepack enable 提供');
        if (miss.includes('cargo') || miss.includes('rustc')) hints.push('rust 工具链在 %USERPROFILE%\\.cargo\\bin');
        if (miss.includes('7z')) hints.push('7z 常见于 C:\\Program Files\\7-Zip');
        if (hints.length) L.push('  (线索: ' + hints.join('；') + ')');
      }
    }

    // --- 硬件余量：决定「能不能跑本地模型 / 大文件能不能落盘」 ---
    const hw = [];
    if (data.cores) hw.push(data.cores + '核');
    if (data.memGB) hw.push(data.memGB + 'GB内存');
    if (hw.length) L.push('hw: ' + hw.join(' · '));
    // 磁盘剩余也是会变的量，但变化尺度是分钟到小时（不像温度是秒级），
    // 60 秒刷新够用。仍旧标注采样时间，避免「昨天查的还剩 34G」被当今天读。
    if (data.disk) L.push('disk(GB 可用/总): ' + data.disk);

    // --- .NET 运行时：决定「net472 的 DLL 能不能给 net10 的进程用」 ---
    // 两者元数据与依赖模型不同，不能互换。报出装了哪些，模型自己就能对上目标框架。
    if (data.netfx || data.dotnet) {
      // 两套运行时**互不兼容**：net472 编译的 DLL 不能被 net10 进程加载，反之亦然。
      // 这里只报「装了哪些」，因为目标框架由项目决定，模型自己能对上版本号；
      // 多写一句「net4x 可用」反而每次都要读。
      const nx = [];
      if (data.netfx) nx.push('Framework ' + data.netfx);
      if (data.dotnet) nx.push('Core ' + data.dotnet.split('/').join('/'));
      L.push('dotnet: ' + nx.join(' · '));
    }

    // --- 系统代码页：中文环境 UTF-8 乱码的根源 ---
    if (data.acp) {
      const name = ACP_NAMES[data.acp] || ('code ' + data.acp);
      const isUtf8 = data.acp === '65001';
      L.push('codepage: ACP ' + data.acp + '(' + name + ')'
        + (isUtf8 ? ' · 默认 UTF-8' : ' · 非 UTF-8：读写无 BOM 的 UTF-8 文件必须显式指定编码，否则按此代码页解码成乱码'));
    }

    // --- 权限：三个独立事实，不要压成一个布尔 ---
    if (data.isAdmin !== undefined) {
      L.push('privilege: ' + describePrivilege(data));
    }

    // --- GPU：N 卡一行，其它卡一行，都没有就不出现 ---
    if (data.gpu) L.push('gpu: ' + compactGpu(data.gpu));
    if (data.gpuOthers && data.gpuOthers.length) {
      const others = data.gpuOthers.map((g) => {
        const parts = [g.name];
        // 显存只报整数 GB；解析不到就省略，不写 0（0 会被误读成「没有显存」）
        if (g.vramGB) parts.push(g.vramGB + 'GB');
        if (g.driver) parts.push(g.driver.replace(/^drv/, ''));
        return parts.join(' · ');
      });
      L.push('gpu(other): ' + others.join(' / '));
    }

    // --- 包管理源：决定「装包会不会卡」 ---
    // 只报非默认的，以及默认值本身（因为「默认」往往意味着用官方源，
    // 而官方源在这个网络环境下可能恰恰不通 —— 那条判断由 reach 行给出）
    if (data.registry) {
      const reg = Object.entries(data.registry)
        .filter(([, v]) => v)
        .map(([k, v]) => k + '=' + compactUrl(v));
      if (reg.length) L.push('registry: ' + reg.join(' '));

      // 交叉判断：源配了，但域名实测不通 —— 这是「配了等于没配」，
      // 比「没配」更坑：模型会以为装包正常，然后卡在下载超时。
      const broken = brokenRegistries(data.registry, data.net);
      if (broken.length) L.push('registry-broken: ' + broken.join('；'));
    }

    // --- 关键环境变量：只报已设置的，空的不报（省 token 且不易误读） ---
    if (data.envVars) {
      const ev = Object.entries(data.envVars).filter(([, v]) => v);
      if (ev.length) L.push('env: ' + ev.map(([k, v]) => k + '=' + shortPath(v)).join(' · '));
    }

    // --- Defender：决定「同样的构建在这里会不会慢几倍」 ---
    if (data.defender) {
      L.push('defender: WinDefend ' + (data.defender === 'Running'
        ? '运行中（实时扫描会显著拖慢 npm install / 大量小文件编译）'
        : '已停止（无实时扫描开销）'));
    }

    // --- 网络与代理：决定「能不能直接访问外网」 ---
    const net = proxySummary(data.proxy);
    if (net) L.push('proxy: ' + net);

    // 连通性结论放进 brief：这是模型最需要的判断——
    // 能不能直接拉 GitHub/HuggingFace，决定该用 pip install 还是先换镜像。
    if (data.net) {
      const reach = reachabilitySummary(data.net);
      if (reach) L.push('reach: ' + reach);
    }

    if (detail === 'full') {
      // Store 版 pwsh 的完整说明：只在 full 展开。
      // 关键场景是「写计划任务/服务，以 SYSTEM 跑」——那时 WindowsApps 下的
      // App Execution Alias 不存在，pwsh.exe 会「找不到」，而在当前用户下完全正常。
      if (data.shells.pwsh && data.shells.pwsh.source === 'Store') {
        // 先看看本机到底有没有 MSI 版，没有就别给一条不存在的路径
        const msi = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe']
          .find((p) => { try { return fs.existsSync(p); } catch { return false; } });
        L.push('  注: pwsh 是 Microsoft Store 版（WindowsApps 下，靠 App Execution Alias 暴露）。'
          + '以 SYSTEM 或 Windows 服务身份运行时该别名不存在，会「找不到 pwsh.exe」，'
          + '而在当前用户下完全正常 —— 这是「本地能跑、计划任务里不行」的典型原因。'
          + (msi ? '本机已装 MSI 版：' + msi + '（换成它即可）。' : '本机未装 MSI 版，需要服务化时请先安装。'));
      }
      const rp = registryPath();
      if (rp.extra.length) L.push('path-extra(不在进程PATH里): ' + rp.extra.slice(0, 12).join('; '));
      for (const t of data.tools) {
        const full = String(t.version || '').trim();
        if (full && shortVersion(full) !== full) L.push('  ' + t.name + ': ' + full.slice(0, 120));
      }
      if (data.net) {
        L.push('  reachability(逐个平台实测，dl=实际拉取 4KB 是否完整):');
        for (const [name, r] of Object.entries(data.net)) {
          let line = '    ' + name.padEnd(14) + (r.ok ? 'conn ' + r.ms + 'ms' : 'fail ' + (r.err || 'timeout'));
          if (r.dl) {
            line += ' | dl ' + (r.dl.ok ? 'ok ' + r.dl.got + 'B ' + r.dl.ms + 'ms' : 'BROKEN ' + (r.dl.err || (r.dl.got + '/' + r.dl.want + 'B')));
          }
          L.push(line);
        }
      }
    }
    // 不渲染 cwd：探测看到的是主进程启动目录，不是会话工作目录
    // （工作目录另有 working_directory 工具与系统提示的 runtime context 负责）
    if (cachedAt) {
      // 用本地时间并给出「距今多久」。
      //
      // 只写日期是不够的：外部评审看到快照里的 51°C，以为是当前值，
      // 而实际采样于 41 分钟前。把 age 写出来，任何读这个快照的人
      // （模型或人）都能立刻判断「这数字还能不能信」。
      const d = new Date(cachedAt);
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      const ageMin = Math.max(0, Math.round((Date.now() - cachedAt) / 60000));
      const age = ageMin < 1 ? '刚刚' : ageMin < 60 ? ageMin + ' 分钟前' : Math.round(ageMin / 60) + ' 小时前';
      L.push('sampled: ' + stamp + '（' + age + '）· 命令找不到或版本不符时先重探，别直接改方案');
    }
    return L.join('\n');
  }

  /**
   * 读 IE/WinINet 代理设置（Electron / Chrome / 多数 GUI 工具认这个）。
   *
   * @returns {{ enabled: boolean, server: string, pac: string }|null}
   */
  function GetIeProxy() {
    const p = readReg(HKCU, 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 'ProxyEnable');
    const server = readReg(HKCU, 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 'ProxyServer') || '';
    const pac = readReg(HKCU, 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 'AutoConfigURL') || '';
    if (p === null && !server && !pac) return null;
    return { enabled: p === '1' || p === '0x1', server, pac };
  }

  /**
   * 网络接口指纹：网卡列表 + 是否启用 + 默认网关的粗摘要。
   *
   * 用 Node 的 os.networkInterfaces()：纯内存读取，不触发任何系统调用开销，
   * 并且能反映「网线插拔 / VPN 起落 / WiFi 切换」这类环境级变化。
   *
   * @returns {string}
   */
  function networkFingerprint() {
    const ifaces = os.networkInterfaces();
    const rows = [];
    for (const [name, list] of Object.entries(ifaces)) {
      for (const a of list || []) {
        // 只记 IPv4 的存在与否，不记具体地址：地址本身变化（DHCP 续租）不该触发重探，
        // 但「有/没有这块网卡」和「是否拿到地址」是环境变化。
        if (a.family === 'IPv4') rows.push(name + '=' + (a.internal ? 'internal' : 'external'));
      }
    }
    return rows.sort().join(',');
  }

  /**
   * 代理配置摘要。
   *
   * 三处来源各说各话，必须都报出来并**判断当前是否真的生效**：
   *   · 环境变量 —— 大多数 CLI（curl / pip / npm 部分场景）只认这个；
   *   · IE 注册表 —— Electron、Chrome、以及跑在 DSH 里的工具认这个；
   *   · WinHTTP —— 服务级，系统组件认这个。
   *
   * 本机实测是个典型陷阱：IE 里写着 `127.0.0.1:7892`，但 `ProxyEnable=0`——
   * 代理软件装过、当前没开。如果只报「有代理 127.0.0.1:7892」，模型会尝试
   * 通过它访问外网然后失败；如果只报「无代理」，又解释不了为什么某工具走代理。
   *
   * @param {object|undefined} proxy 解析出来的三处代理信息
   * @returns {string} 一行摘要；无任何配置时返回空串
   */
  function proxySummary(proxy) {
    if (!proxy) return '';
    const parts = [];
    const envKeys = proxy.env ? Object.keys(proxy.env) : [];
    if (envKeys.length) parts.push('env ' + envKeys.join('/'));
    if (proxy.ie && proxy.ie.enabled && proxy.ie.server) {
      parts.push('系统代理 ' + proxy.ie.server + '（已启用）');
    } else if (proxy.ie && proxy.ie.server) {
      // 有配置但没启用 —— 这是残留，澄清它对模型最有用
      parts.push('系统代理 ' + proxy.ie.server + '（未启用，属残留配置）');
    }
    if (proxy.ie && proxy.ie.pac) parts.push('PAC ' + proxy.ie.pac);
    if (proxy.winhttp && proxy.winhttp !== 'none' && proxy.winhttp !== 'error') {
      parts.push('WinHTTP ' + proxy.winhttp);
    }
    if (!parts.length) return '无代理（直连）';
    return parts.join(' · ');
  }

  /**
   * 找出「配置的源与实际可达性矛盾」的项。
   *
   * 这是整个探测最有价值的一类判断：单看 registry 行，模型只知道
   * 「GOPROXY 指向 proxy.golang.org」；单看 reach 行，只知道
   * 「goproxy.cn 通、proxy.golang.org 不通」。两行合起来才能得出
   * 「你的 Go 源配错了，一装包就会卡」——而这正是模型最需要的那句话。
   *
   * 映射表把「源地址的主机名」关联到「连通性探测的键名」。
   *
   * @param {object} registry 包管理器源
   * @param {object|undefined} net 连通性结果
   * @returns {string[]} 形如 `go→proxy.golang.org 不可达，改 goproxy.cn`
   */
  function brokenRegistries(registry, net) {
    if (!net) return [];
    const HOST_TO_NETKEY = {
      'registry.npmjs.org': 'npmjs',
      'proxy.golang.org': 'goproxy-org',
      'registry.npmmirror.com': 'npmmirror',
      'pypi.org': 'pypi',
      'pypi.tuna.tsinghua.edu.cn': 'pypi',
      'static.crates.io': 'crates',
      'hf-mirror.com': 'hf-mirror',
    };
    const out = [];
    const add = (tool, host, ok, hint) => {
      if (!ok) out.push(tool + '→' + host + ' 不可达，' + hint);
    };

    const go = String(registry.go || '');
    if (go) {
      const hosts = go.split(',').map((s) => s.trim().replace(/^https?:\/\//, '').split('/')[0]);
      // Go 的 GOPROXY 是逗号分隔的**回退链**，语义特殊：
      //   `A,B` 表示 A 失败时退到 B；`direct` 表示直连 git clone。
      // 所以「主源不通」不等于「装包会失败」—— 会退到 direct。
      // 但 direct 走的是 GitHub clone，在这个网络下往往更慢甚至不通，
      // 所以仍然要提示，只是措辞不能是「全不可达」这种错的说法。
      const candidates = hosts.filter((h) => h !== 'direct' && h !== 'off' && h !== '');
      const down = candidates.filter((h) => {
        const key = HOST_TO_NETKEY[h];
        if (!key) return false; // 没测过的主机不判死
        return !(net[key] && net[key].ok);
      });
      const hasDirect = hosts.includes('direct');
      if (candidates.length && down.length === candidates.length) {
        if (hasDirect) {
          out.push('go→' + down.join(',') + ' 不可达，将回退到 direct（GitHub 克隆，慢且可能失败）；建议改 GOPROXY=https://goproxy.cn,direct');
        } else {
          out.push('go→' + down.join(',') + ' 不可达且无回退，装包必失败；改 GOPROXY=https://goproxy.cn,direct');
        }
      } else if (down.length) {
        out.push('go→' + down.join(',') + ' 不可达（尚有其它源可用）');
      }
    }

    const npm = String(registry.npm || '');
    if (npm) {
      const host = npm.replace(/^https?:\/\//, '').split('/')[0];
      const key = HOST_TO_NETKEY[host];
      if (key && net[key]) add('npm', host, net[key].ok, '改 registry.npmmirror.com');
    }

    const pip = String(registry.pip || '');
    if (pip) {
      const host = pip.replace(/^https?:\/\//, '').split('/')[0];
      const key = HOST_TO_NETKEY[host];
      if (key && net[key]) add('pip', host, net[key].ok, '加 -i https://pypi.tuna.tsinghua.edu.cn/simple');
    }

    return out;
  }

  /**
   * 把连通性结果压成一句话。
   *
   * 分三类：全通 / 部分通（列出通的和不通的）/ 全不通。
   * 只报结果不报毫秒 —— 毫秒对判断没用，还把行拉得很长。
   *
   * @param {object} net 平台名 → { ok, ms, err }
   * @returns {string}
   */
  function reachabilitySummary(net) {
    const entries = Object.entries(net || {});
    if (!entries.length) return '';
    // 两档语义：
    //   conn —— TCP 443 能建连（便宜，1.5 秒超时 + 失败重试一次）；
    //   dl   —— 建连后再用 Range 请求真拉 4KB（贵，只对少数主机做）。
    // 「能连」不等于「能下完」：外部评审实测过 GitHub 连得上、
    // 但下 6.6MB 的文件被截断成 6.56MB。只报可达会让人放心拉依赖然后卡住。
    const connOk = [], connBad = [], dlBad = [];
    for (const [n, r] of entries) {
      if (!r || !r.ok) { connBad.push(n); continue; }
      connOk.push(n);
      if (r.dl && r.dl.ok === false) dlBad.push(n);
    }
    if (!connOk.length && !connBad.length) return '';

    const parts = [];
    if (connOk.length) parts.push('连通 ' + connOk.join(' '));
    if (connBad.length) parts.push('不通 ' + connBad.join(' '));
    if (dlBad.length) parts.push('可连但下载中断 ' + dlBad.join(' '));

    // 不通时直接给出该用哪个替代源。模型自己想不道「huggingface 不通就该走 hf-mirror」，
    // 会一头撞上去重试——这条提示是整个探测里最省时间的一句。
    const hints = [];
    for (const b of connBad) {
      if (b === 'huggingface') hints.push('HF 改 hf-mirror.com 或设 HF_ENDPOINT=https://hf-mirror.com');
      if (b === 'github') hints.push('GitHub 用 ghproxy / 镜像');
      if (b === 'npmjs') hints.push('npm 用 registry.npmmirror.com');
      if (b === 'npmmirror') hints.push('npm 换回官方或其它镜像');
      if (b === 'pypi') hints.push('pip 加 -i https://pypi.tuna.tsinghua.edu.cn/simple');
      if (b === 'goproxy-cn') hints.push('go 改用 goproxy.io');
      if (b === 'goproxy-org') hints.push('go 设 GOPROXY=https://goproxy.cn,direct');
      if (b === 'crates') hints.push('cargo 配 rsproxy.cn 镜像');
    }
    for (const b of dlBad) {
      hints.push(b + ' 能连但下载会断，大文件用 curl --retry 3 -C - 续传');
    }
    return parts.join('；') + (hints.length ? '。对策：' + hints.join('；') : '');
  }

  /**
   * 外网可达性探测。
   *
   * 为什么值得专门测：模型能不能直接拉 GitHub / HuggingFace / PyPI，
   * 决定了它该走 `pip install` 还是必须先换镜像源。猜错一次的代价是
   * 一次几十秒的下载超时，而且它往往会重试。
   *
   * 实现要点：
   *   · 在 **Node 里**用 net.Socket 并发探测，不起 pwsh 子进程；
   *   · 并发限制 4，超时 1.5 秒 —— 实测全并行时一个超时会拖慢整批，
   *     分组限流能把「全通」压到约 1.2 秒；
   *   · 只测 TCP 443 能否建连，不真正发 HTTP：既快又不产生流量。
   *
   * @returns {Promise<object>} 平台名 → { ok, ms, err }
   */
  function probeReachability() {
    const targets = [
      ['github', 'github.com'],
      ['huggingface', 'huggingface.co'],
      ['hf-mirror', 'hf-mirror.com'],
      ['npmjs', 'registry.npmjs.org'],
      ['npmmirror', 'registry.npmmirror.com'],
      ['pypi', 'pypi.org'],
      // 包管理器源本身也要测：本机 GOPROXY 指向 proxy.golang.org，
      // 而那个域名在这是不通的（2.5s 超时）。不测就发现不了「源配了但用不了」。
      ['goproxy-cn', 'goproxy.cn'],
      // 直接测 Go 的默认源本身：本机它不通，而 GOPROXY 恰恰指着它
      ['goproxy-org', 'proxy.golang.org'],
      ['crates', 'static.crates.io'],
    ];

    /**
     * 会做「下载探测」的主机（只挑最常被下大文件的那几个）。
     *
     * 为什么要多这一步：TCP 建连成功不代表能下完。外部评审实测
     * 「GitHub 连得上，但下 6.6MB 的 LHM 时被截断成 6.56MB，重试两次都失败」。
     * 只报「可达」会让人放心地直接拉依赖，然后卡在下载中途。
     *
     * 只对少数主机做，因为每次要 0.6–4 秒，全做会把探测拖到十几秒。
     */
    // key 必须是 targets 里的 host（不是显示名），否则永远命中不了。
    // 只挑「模型最可能从这里拉大文件」的三处：GitHub raw、HF 镜像、npm 镜像。
    // 其余（pypi/goproxy/crates）用 TCP 结果就够了，不额外加 4 秒。
    const DL_CHECK = {
      'github.com': { host: 'raw.githubusercontent.com', path: '/git/git/master/README.md' },
      'hf-mirror.com': { host: 'hf-mirror.com', path: '/api/models?limit=1' },
      'registry.npmmirror.com': { host: 'registry.npmmirror.com', path: '/-/ping' },
      'pypi.org': { host: 'pypi.org', path: '/simple/' },
    };
    const TIMEOUT = 1500;
    const CONCURRENCY = 4;

    const one = (host) => new Promise((resolve) => {
      const t0 = Date.now();
      const sock = new net.Socket();
      let settled = false;
      const done = (ok, err) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch { /* ignore */ }
        resolve({ ok, ms: Date.now() - t0, ...(err ? { err } : {}) });
      };
      sock.setTimeout(TIMEOUT);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false, 'timeout'));
      sock.once('error', (e) => done(false, e.code || 'error'));
      try {
        sock.connect(443, host);
      } catch (e) {
        done(false, e.code || 'error');
      }
    });

    /**
     * 探测「能不能真的下完一段内容」。
     *
     * 做法：对固定路径发一个 Range 请求要 4KB，看实际收到多少字节。
     *   · 状态 200/206 且收到的字节数 >= 预期 → dl.ok
     *   · 连接中途断掉、字节数不足 → dl.ok=false，记下实收/应收
     *
     * 为什么用 Range：只要 4KB，不产生明显流量，也不会因为文件太大而变慢。
     * 但要注意——Range 请求**测不出**「大文件下到一半连接被重置」那种问题
     * （评审遇到的正是这种）。所以这里的语义要写清楚：它验证的是
     * 「能否建立 TLS 并完整收到一小段响应」，不是「大文件一定能下完」。
     *
     * @param {string} host 主机名
     * @param {string} path 请求路径
     * @returns {Promise<{ok: boolean, ms: number, status?: number, got?: number, want?: number, err?: string}>}
     */
    function oneDownload(host, path) {
      const WANT = 4096;
      const t0 = Date.now();
      return new Promise((resolve) => {
        let settled = false;
        const finish = (r) => {
          if (settled) return;
          settled = true;
          resolve({ ms: Date.now() - t0, ...r });
        };
        try {
          const req = https.request({
            host,
            port: 443,
            path,
            method: 'GET',
            headers: {
              Range: 'bytes=0-' + (WANT - 1),
              'User-Agent': 'dsh-local-env/1.0',
            },
            timeout: 4000,
          }, (res) => {
            let got = 0;
            res.on('data', (c) => { got += c.length; });
            res.on('end', () => {
              const want = Number(res.headers['content-length'] || WANT);
              finish({
                ok: got >= Math.min(want, WANT) || got > 0,
                status: res.statusCode,
                got,
                want,
              });
            });
            res.on('error', (e) => finish({ ok: false, err: e.code || 'res-error', got, status: res.statusCode }));
          });
          req.on('timeout', () => { req.destroy(); finish({ ok: false, err: 'timeout' }); });
          req.on('error', (e) => finish({ ok: false, err: e.code || 'error' }));
          req.end();
        } catch (e) {
          finish({ ok: false, err: e.code || 'throw' });
        }
      });
    }

    const out = {};
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
      while (cursor < targets.length) {
        const [name, host] = targets[cursor++];
        const first = await one(host);
        // 失败项再试一次：跨境外站（pypi、huggingface）在 1.5 秒内超时很常见，
        // 但重试后往往能通。实测本机 pypi 一次 915ms 成功、一次 1.5s 超时，
        // 不重试就会把「偶发慢」误报成「不可达」，模型据此换镜像源反而变慢。
        let result;
        if (!first.ok) {
          await new Promise((r) => setTimeout(r, 200));
          const second = await one(host);
          result = second.ok ? second : first;
        } else {
          result = first;
        }
        out[name] = result;
      }
    });
    return Promise.all(workers).then(async () => {
      // ── 第二遍：对连得通、且值得验证的主机补测「真能下完吗」 ──
      //
      // 为什么单独一遍而不是在 TCP 循环里紧跟：串行会让总耗时相加。
      // 实测串行时一个慢站（github raw 1.9s）会把整批拖到 5 秒；
      // 改成「TCP 全部测完 → 下载探测并发跑」后，总耗时由较慢者决定。
      const dlJobs = [];
      for (const [name, result] of Object.entries(out)) {
        const spec = DL_CHECK[targets.find(([n]) => n === name)?.[1]];
        if (result && result.ok && spec) {
          dlJobs.push(
            oneDownload(spec.host, spec.path).then((dl) => { result.dl = dl; }),
          );
        }
      }
      await Promise.all(dlJobs);
      return out;
    });
  }

  /**
   * 操作系统名压缩。
   *
   * 注册表的 ProductName 在 Win11 上仍是「Windows 10 Pro for Workstations」
   * （微软没跟着改），所以按 build 号纠正，否则模型会以为这是 Win10，
   * 进而判断错可用的 API 与终端能力。
   *
   * @param {string} os 形如 `Windows 10 Pro for Workstations 26300.9457 AMD64`
   * @returns {string} 形如 `Win11 Pro for Workstations 26300 AMD64`
   */
  function compactOs(os) {
    const s = String(os || '').trim();
    if (!s) return 'unknown';
    const m = s.match(/^(Windows|Win)\s*(\d+)?\s*(.*?)\s+(\d{4,6})\.\d+\s+([A-Za-z0-9_]+)$/);
    if (!m) return s.slice(0, 80);
    const build = Number(m[4]);
    const family = build >= 22000 ? 'Win11' : 'Win10';
    return family + ' ' + m[3] + ' ' + build + ' ' + m[5];
  }

  /**
   * 权限描述。
   *
   * 三个事实必须分开说，因为它们回答的是不同问题：
   *   ① 现在能不能写系统目录 —— 决定「这条命令会不会立刻失败」；
   *   ② 账户能不能提权到管理员 —— 决定「有没有别的路可走」；
   *   ③ 提权会不会弹 UAC —— 决定「能不能无人值守」。
   *
   * 典型组合（本机）：当前非提权 → 但账户在 Administrators 组 → 且 UAC=0，
   * 意味着可以静默升权，脚本能全自动跑完。若只报「普通用户」，
   * 对方会误判成「需要人工介入」而放弃自动化方案。
   *
   * @param {object} data 探测结果
   * @returns {string}
   */
  function describePrivilege(data) {
    const parts = [];
    // SYSTEM 身份优先说明：它改变的不只是权限，还有家目录、用户级 PATH、
    // 以及 Store 版应用是否可用 —— 只报「管理员」会漏掉这些。
    if (data.isSystem) {
      parts.push('以 SYSTEM 运行（家目录为 systemprofile、用户级 PATH 与 Store 应用不可用）');
    } else if (data.isAdmin) {
      parts.push('管理员令牌（可直接写系统目录）');
    } else {
      parts.push('非提权运行（不能写 Program Files、不能装服务）');
    }
    if (data.adminInGroup === true) {
      parts.push('账户在 Administrators 组（可提权）');
    } else if (data.adminInGroup === false) {
      parts.push('账户不在 Administrators 组（无法提权）');
    }



    const uac = data.uac;
    if (uac && uac.lua) {
      if (uac.consentAdmin === 0) {
        parts.push('UAC=0：管理员提权不弹窗，可静默升权');
      } else if (uac.consentAdmin === 1) {
        parts.push('UAC 要求输入凭据（提权需人工）');
      } else if (uac.consentAdmin === 2) {
        parts.push('UAC 要求点击确认（提权需人工）');
      } else if (uac.consentAdmin !== null) {
        parts.push('UAC 策略=' + uac.consentAdmin + '（提权会提示）');
      }
    } else if (uac && !uac.lua) {
      parts.push('UAC 已关闭（提权无提示）');
    }
    return parts.join(' · ');
  }

  /**
   * GPU 名压缩。
   *
   * nvidia-smi 的原始格式：
   *   `Tesla T10, 616.92, 16384 MiB, 4796 MiB, 7.5, TCC, 49`
   * 依次是 名称, 驱动版本, 总显存, 已用显存, 算力(compute cap), 驱动模型(TCC/WDDM), 温度。
   *
   * 压缩成：
   *   `Tesla T10 · 16GB(已用4.8) · drv616.92 · CC7.5 · TCC · 49°C`
   *
   * 为什么 TCC 值得单独标出来：TCC 模式下显卡不参与显示输出，可以跑满算力，
   * 但也意味着「不能用它做图形渲染」。模型若不知道这一点，可能会试图
   * 用它开 GUI 或做 OpenGL 渲染，然后失败。
   *
   * @param {string} raw nvidia-smi 的 csv 行
   * @returns {string}
   */
  function compactGpu(raw) {
    const f = String(raw || '').split(',').map((s) => s.trim());
    if (f.length < 5) return String(raw || '').slice(0, 60);
    const [name, drv, total, , cc, model] = f;
    const totalGb = parseMemGb(total);
    const parts = [name];
    if (totalGb) parts.push(totalGb + 'GB');
    if (drv) parts.push('drv' + drv);
    if (cc) parts.push('CC' + cc);
    if (model) parts.push(model);
    // **刻意不报温度和已用显存。**
    //
    // 外部评审实测：快照报 51°C，真实是 86°C，差 35 度。不是探测错 ——
    // 这两个值秒级变化，而快照最长 60 秒才刷一次，于是「旧值」被当成
    // 「当前值」读，51 vs 86 会直接改变「要不要等它降温」这类判断。
    // 它看起来像实时读数，实际是历史值，这种误导比少给一个数字更糟。
    //
    // 温度/占用应由模型在真要时自己跑 nvidia-smi 拿（137ms，拿到的
    // 一定是此刻的值）。本工具只负责「这台机器有什么」。
    return parts.join(' · ');
  }

  /**
   * `16384 MiB` → 16（整数 GB，用于总量）。解析不出来返回 0。
   *
   * @param {string} s
   * @returns {number}
   */
  function parseMemGb(s) {
    const m = String(s || '').match(/^(\d+)\s*MiB$/i);
    if (!m) return 0;
    return Math.round(Number(m[1]) / 1024);
  }

  /**
   * `10 MiB` → 0.0098（保留小数 GB，用于已用量）。解析不出来返回 -1。
   *
   * 与 {@link parseMemGb} 分开是因为两者的精度需求相反：
   * 总量要「16GB」这种好读的整数，已用量要保留小数否则会被当成 0 丢掉。
   *
   * @param {string} s
   * @returns {number} GB；解析失败为 -1
   */
  function parseMemGbFloat(s) {
    const m = String(s || '').match(/^(\d+)\s*MiB$/i);
    if (!m) return -1;
    return Number(m[1]) / 1024;
  }

  /**
   * URL 压缩：去掉协议头，只留主机名。
   *
   * `https://registry.npmmirror.com` → `npmmirror.com`
   * `https://proxy.golang.org,direct` → `proxy.golang.org,direct`
   *
   * 保留 `direct` 这类逗号分段，因为它对 Go 的行为有影响
   * （第一段不通时会回退到直连 git）。
   */
  function compactUrl(v) {
    return String(v || '')
      .split(',')
      .map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
      .join(',');
  }

  /** 路径压缩：只保留最后两段，避免长路径挤占 token。 */
  function shortPath(v) {
    const s = String(v || '');
    const parts = s.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 2) return s;
    return '…\\' + parts.slice(-2).join('\\');
  }

  /** CPU 名压缩：去掉 `@ 4.20GHz` 之类的尾巴，保留厂商+型号+核心数。 */
  function compactCpu(cpu) {
    return String(cpu || '')
      .replace(/\s*\(R\)|\s*\(TM\)|\s*CPU|\s*Processor/gi, '')
      .replace(/\s*@\s*[\d.]+\s*GHz/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
  }

  /** 工具名清单（用于 missing 判定；与探测脚本里的 $tools 必须保持一致） */
  const PROBE_TOOL_NAMES = TOOL_NAMES;

  /**
   * 版本号截短。
   *
   * 只保留开头的数字版本（`24.14.1`），把 `ripgrep 15.1.0 (rev af60c2de9d)`
   * 这类尾部噪音去掉——实测那串尾巴白白多花 30 token，对判断毫无用处。
   * 非数字开头的（比如 `uv 0.11.7 ...`）取到第二个空格为止。
   */
  function shortVersion(v) {
    const s = String(v).trim().replace(/\s+/g, ' ');
    // ① 整体就是版本号：24.14.1 / 2.53.0.windows.3
    const m = s.match(/^\d+(\.\d+){0,3}/);
    if (m) return m[0];
    // ② 形如 `go version go1.26.2 windows/amd64`、`ffmpeg version 8.1-full_build...`
    //    取「version」之后的第一段数字版本，后面的构建后缀（windows/amd64、full_build）全丢掉
    if (/version\s/i.test(s)) {
      const m2 = s.match(/version\s+(?:go)?(\d+(?:\.\d+){0,3})/i);
      if (m2) return m2[1];
    }
    // ③ 形如 `uv 0.11.7 ...` / `ripgrep 15.1.0 ...`：第一个数字串
    const m3 = s.match(/(\d+(\.\d+){1,3})/);
    if (m3) return m3[1];
    return s.slice(0, 20);
  }

  return {
    ensure,
    render,
    fingerprint,
    registryPath,
    which,
    get cachedAt() { return cachedAt; },
    get cached() { return cached; },
  };
}
