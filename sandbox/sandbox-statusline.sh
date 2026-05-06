#!/bin/bash
# Sandbox statusline for Claude Code — sourced as a command by the statusLine setting.
# Identical to the host statusline but with a bold "Sandbox" label before the model.

RESET='\033[0m'
GREY='\033[0;90m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[0;37m'
RED='\033[0;31m'
BOLD_BLUE='\033[1;34m'

# Pull all inputs from JSON in one jq call (one value per line)
{
  read -r dir
  read -r model
  read -r output_style
  read -r context_used
  read -r vim_mode
  read -r agent_name
} < <(jq -r '
  .workspace.current_dir,
  .model.display_name,
  (.output_style.name // "default"),
  (.context_window.used_percentage // ""),
  (.vim.mode // ""),
  (.agent.name // "")
')

name=$(basename "$dir")

# Git info
git_line=""
if git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
  branch=$(git -C "$dir" branch --show-current 2>/dev/null || echo "detached")
  changed=$(git -C "$dir" --no-optional-locks diff --name-only 2>/dev/null | wc -l | tr -d ' ')
  staged=$(git -C "$dir" --no-optional-locks diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
  total=$((changed + staged))

  dirty=""
  [ "$total" -gt 0 ] && dirty=$(printf " ${YELLOW}✗%s${RESET}" "$total")

  unpushed=""
  no_upstream=""
  if upstream=$(git -C "$dir" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null) && [ -n "$upstream" ]; then
    ahead=$(git -C "$dir" rev-list --count @{u}..HEAD 2>/dev/null || echo 0)
    behind=$(git -C "$dir" rev-list --count HEAD..@{u} 2>/dev/null || echo 0)
    [ "$ahead" -gt 0 ] && unpushed=" ↑$ahead"
    [ "$behind" -gt 0 ] && unpushed="${unpushed} ↓$behind"
  else
    no_upstream=$(printf " ${YELLOW}⚡unpublished${RESET}")
  fi

  git_line=$(printf "${BOLD_BLUE}🌿 ${RED}%s${RESET}%s${PURPLE}%s${RESET}%s \n" \
    "$branch" "$dirty" "$unpushed" "$no_upstream")
fi

# Context usage (color-coded)
context_info=""
if [ -n "$context_used" ]; then
  pct_int=${context_used%.*}
  if [ "$pct_int" -lt 50 ]; then
    ctx_color="$GREEN"
  elif [ "$pct_int" -lt 80 ]; then
    ctx_color="$YELLOW"
  else
    ctx_color="$RED"
  fi
  context_info=$(printf " ${ctx_color}🧠 %.1f%%${RESET}" "$context_used")
fi

# Vim mode
vim_info=""
case "$vim_mode" in
  "")     ;;
  INSERT) vim_info=$(printf " ${GREEN}INSERT${RESET}") ;;
  *)      vim_info=$(printf " ${CYAN}NORMAL${RESET}") ;;
esac

# Agent name
agent_info=""
[ -n "$agent_name" ] && agent_info=$(printf " ${PURPLE}agent: %s${RESET}" "$agent_name")

# Output style (only show non-default)
style_info=""
[ "$output_style" != "default" ] && style_info=$(printf " ${BLUE}%s${RESET}" "$output_style")

# Render
printf "${YELLOW}Sandbox${RESET} ${GREY}│${RESET} ${WHITE}🤖 %s${RESET} ${GREY}│${RESET}%s ${GREY}│${RESET} ${CYAN}📁 %s${RESET}%s%s%s\n%s" \
  "$model" "$context_info" "$name" "$vim_info" "$agent_info" "$style_info" "$git_line"
