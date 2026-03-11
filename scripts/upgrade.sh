#!/bin/bash
# QQBot 插件升级脚本
# 用于清理旧版本插件并重新安装
# 兼容 clawdbot 和 openclaw 两种安装

set -e

echo "=== QQBot 插件升级脚本 ==="

# 检测使用的是 clawdbot 还是 openclaw
detect_installation() {
  if [ -d "$HOME/.clawdbot" ]; then
    echo "clawdbot"
  elif [ -d "$HOME/.openclaw" ]; then
    echo "openclaw"
  else
    echo ""
  fi
}

# 可能的扩展目录名（原仓库 qqbot + 本仓库框架推断名 openclaw-qq）
EXTENSION_DIRS=("qqbot" "openclaw-qq" "openclaw-qqbot")

# 清理指定目录的函数
# 参数: $1=base目录 $2=app名称
cleanup_installation_at() {
  local BASE_DIR="$1"
  local APP_NAME="$2"
  local APP_DIR="$BASE_DIR/.$APP_NAME"
  local CONFIG_FILE="$APP_DIR/$APP_NAME.json"

  echo ""
  echo ">>> 处理 $APP_NAME 安装..."

  # 1. 删除所有可能的旧扩展目录
  for dir_name in "${EXTENSION_DIRS[@]}"; do
    local ext_dir="$APP_DIR/extensions/$dir_name"
    if [ -d "$ext_dir" ]; then
      echo "删除旧版本插件: $ext_dir"
      rm -rf "$ext_dir"
    fi
  done

  # 2. 清理配置文件中所有可能的插件 ID 相关字段
  if [ -f "$CONFIG_FILE" ]; then
    echo "清理配置文件中的插件字段..."
    
    # 使用 node 处理 JSON（比 jq 更可靠处理复杂结构）
    node -e "
      const fs = require('fs');
      const config = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
      const ids = ['qqbot', 'openclaw-qq', '@sliverp/qqbot', '@tencent-connect/qqbot', '@tencent-connect/openclaw-qq', '@tencent-connect/openclaw-qqbot', 'openclaw-qqbot'];
      
      for (const id of ids) {
        // 删除 channels.<id>
        if (config.channels && config.channels[id]) {
          delete config.channels[id];
          console.log('  - 已删除 channels.' + id);
        }
        
        // 删除 plugins.entries.<id>
        if (config.plugins && config.plugins.entries && config.plugins.entries[id]) {
          delete config.plugins.entries[id];
          console.log('  - 已删除 plugins.entries.' + id);
        }
        
        // 删除 plugins.installs.<id>
        if (config.plugins && config.plugins.installs && config.plugins.installs[id]) {
          delete config.plugins.installs[id];
          console.log('  - 已删除 plugins.installs.' + id);
        }

        // 删除 plugins.allow 中的 <id>
        if (config.plugins && Array.isArray(config.plugins.allow)) {
          const before = config.plugins.allow.length;
          config.plugins.allow = config.plugins.allow.filter((x) => x !== id);
          if (config.plugins.allow.length !== before) {
            console.log('  - 已删除 plugins.allow 项: ' + id);
          }
        }
      }
      
      fs.writeFileSync('$CONFIG_FILE', JSON.stringify(config, null, 2));
      console.log('配置文件已更新');
    "
  else
    echo "未找到配置文件: $CONFIG_FILE"
  fi
}

# 检测并处理所有可能的安装
FOUND_INSTALLATION=""

# 收集所有需要检查的基础目录（$HOME 和可能的其他路径，如 /projects）
BASE_DIRS=("$HOME")
# 如果 openclaw 的实际数据目录不在 $HOME 下（如 /projects/.openclaw），也要检查
for extra_dir in "/projects" "/data" "/opt"; do
  if [ "$extra_dir" != "$HOME" ] && [ -d "$extra_dir" ]; then
    BASE_DIRS+=("$extra_dir")
  fi
done

for BASE in "${BASE_DIRS[@]}"; do
  # 检查 clawdbot
  if [ -d "$BASE/.clawdbot" ]; then
    cleanup_installation_at "$BASE" "clawdbot"
    FOUND_INSTALLATION="clawdbot"
  fi

  # 检查 openclaw
  if [ -d "$BASE/.openclaw" ]; then
    cleanup_installation_at "$BASE" "openclaw"
    FOUND_INSTALLATION="openclaw"
  fi

  # 检查 moltbot
  if [ -d "$BASE/.moltbot" ]; then
    cleanup_installation_at "$BASE" "moltbot"
    FOUND_INSTALLATION="moltbot"
  fi
done

# 如果都没找到
if [ -z "$FOUND_INSTALLATION" ]; then
  echo "未找到 clawdbot / openclaw / moltbot 安装目录"
  echo "请确认已安装其中之一"
  exit 1
fi

# 使用检测到的安装类型作为命令
CMD="$FOUND_INSTALLATION"

echo ""
echo "=== 清理完成 ==="
echo ""
echo "接下来请执行以下命令重新安装插件:"
echo "  cd /path/to/openclaw-qqbot"
echo "  $CMD plugins install ."
echo "  $CMD channels add --channel qqbot --token \"AppID:AppSecret\""
echo "  $CMD gateway restart"
