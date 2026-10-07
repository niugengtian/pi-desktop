import { call } from "@/lib/api-client";
import type { Api } from "@contract/api";
import { useEffect, useLayoutEffect, useState, useCallback, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";

const renderSessionMenuPortal = (content: React.ReactNode) =>
  typeof document?.body?.appendChild === "function" ? createPortal(content, document.body) : content;
import type { SessionInfo } from "@/lib/types";
import { useI18n } from "@/i18n";
import { getSessionDisplayTitle } from "@/lib/session-list";
import { formatDateTime, formatNumber, formatRelativeDateTime } from "@/lib/locale-format";
import { floatingMenuPosition } from "@/lib/floating-menu-position";

type PageProviderBinding = Api["sessions.pageProviderBindings"]["result"]["bindings"][number];
type ModelSessionBinding = Api["sessions.modelSessionBindings"]["result"]["bindings"][number] & {
  label: string;
};

export interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

export function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

export function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div
            style={{
              position: "absolute",
              left: depth * 12 + 6,
              top: 0,
              bottom: 0,
              width: 1,
              background: "var(--border)",
              pointerEvents: "none",
            }}
          />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          isRunning={runningSessionIds.has(node.session.id)}
          isUnread={unreadSessionIds.has(node.session.id)}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("agentRunning", "Agent is running…")}
      aria-label={t("agentRunningStatus", "Agent running")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("newSessionActivity", "New activity")}
      aria-label={t("newSessionActivityLabel", "New session activity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

const sessionMenuItemStyle: CSSProperties = {
  width: "100%",
  minHeight: 34,
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 9px",
  border: 0,
  borderRadius: 6,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
};

function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { language, t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [providerBindings, setProviderBindings] = useState<PageProviderBinding[] | null>(null);
  const [modelBindings, setModelBindings] = useState<ModelSessionBinding[] | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const actionsSummaryRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const restoreFocusFrameRef = useRef<number | null>(null);
  const selectInputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeActionsMenu = useCallback((restoreFocus = false) => {
    setActionsOpen(false);
    if (restoreFocus) {
      if (restoreFocusFrameRef.current !== null) window.cancelAnimationFrame(restoreFocusFrameRef.current);
      restoreFocusFrameRef.current = window.requestAnimationFrame(() => {
        restoreFocusFrameRef.current = null;
        actionsSummaryRef.current?.focus();
      });
    }
  }, []);

  useEffect(
    () => () => {
      if (restoreFocusFrameRef.current !== null) window.cancelAnimationFrame(restoreFocusFrameRef.current);
      if (selectInputTimerRef.current) clearTimeout(selectInputTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!actionsOpen) return;
    const close = () => closeActionsMenu();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [actionsOpen, closeActionsMenu]);

  const title = getSessionDisplayTitle(session);

  const startRename = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      closeActionsMenu();
      setRenameValue(session.name ?? "");
      setRenaming(true);
      if (selectInputTimerRef.current) clearTimeout(selectInputTimerRef.current);
      selectInputTimerRef.current = setTimeout(() => {
        selectInputTimerRef.current = null;
        inputRef.current?.select();
      }, 0);
    },
    [closeActionsMenu, session.name],
  );

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      await call("sessions.rename", { id: session.id, name });
      onRenamed?.();
    } catch (e) {
      console.error("rename failed", e);
    }
  }, [renameValue, session.id, session.name, onRenamed]);

  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      closeActionsMenu();
      // ISSUE-001: block delete while agent is running
      if (isRunning) {
        window.alert(t("deleteRunningSessionBlocked", "This session is still running. Stop it before deleting."));
        return;
      }
      setConfirmDelete(true);
    },
    [closeActionsMenu, isRunning, t],
  );

  const handleDeleteConfirm = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isRunning) {
        window.alert(t("deleteRunningSessionBlocked", "This session is still running. Stop it before deleting."));
        setConfirmDelete(false);
        return;
      }
      setConfirmDelete(false);
      setDeleting(true);
      try {
        await call("sessions.delete", { id: session.id });
        onDeleted?.(session.id);
      } catch (err) {
        window.alert(
          (err instanceof Error ? err.message : String(err)) || t("deleteSessionFailed", "Failed to delete session."),
        );
        setDeleting(false);
      }
    },
    [session.id, onDeleted, isRunning, t],
  );

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  const copyText = useCallback(async (text: string) => {
    try {
      await window.piBridge.writeClipboardText(text);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const positionActionsMenu = useCallback((anchor?: { getBoundingClientRect(): DOMRect }) => {
    const button = anchor ?? actionsSummaryRef.current;
    if (!button) return;
    setMenuPosition(
      floatingMenuPosition({
        anchor: button.getBoundingClientRect(),
        menuWidth: Math.min(280, window.innerWidth - 16),
        menuHeight: actionsMenuRef.current?.offsetHeight ?? 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
  }, []);

  useLayoutEffect(() => {
    if (!actionsOpen || !actionsMenuRef.current || !actionsSummaryRef.current) return;
    const menu = actionsMenuRef.current;
    const next = floatingMenuPosition({
      anchor: actionsSummaryRef.current.getBoundingClientRect(),
      menuWidth: menu.offsetWidth,
      menuHeight: menu.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setMenuPosition((current) => (current?.top === next.top && current.left === next.left ? current : next));
  }, [actionsOpen, providerBindings, modelBindings]);

  const loadProviderBindings = useCallback(async () => {
    setProviderBindings(null);
    setModelBindings(null);
    try {
      const [page, model, accounts] = await Promise.all([
        call("sessions.pageProviderBindings", { id: session.id }),
        call("sessions.modelSessionBindings", { id: session.id }),
        call("accounts.list").catch(() => ({ accounts: [] })),
      ]);
      const names = new Map(accounts.accounts.map((account) => [account.provider, account.name]));
      setProviderBindings(page.bindings);
      setModelBindings(
        model.bindings.map((binding) => {
          const divider = binding.model.indexOf("/");
          const provider = binding.model.slice(0, divider);
          const modelId = binding.model.slice(divider + 1);
          return { ...binding, label: `${names.get(provider) ?? provider} · ${modelId}` };
        }),
      );
    } catch (error) {
      console.error("failed to load session bindings", error);
      setProviderBindings([]);
      setModelBindings([]);
    }
  }, [session.id]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = 54;

  return (
    <div
      role="listitem"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
      }}
      style={{
        height: ITEM_HEIGHT,
        position: "relative",
        zIndex: actionsOpen ? 20 : undefined,
        display: "flex",
        alignItems: "center",
        margin: "0 4px 3px",
        paddingLeft: depth > 0 ? depth * 12 + 10 : 10,
        paddingRight: 8,
        cursor: "default",
        background: confirmDelete
          ? "color-mix(in srgb, var(--danger) 8%, transparent)"
          : isSelected
            ? "var(--bg-selected)"
            : hovered
              ? "var(--bg-hover)"
              : "transparent",
        border: confirmDelete
          ? "1px solid color-mix(in srgb, var(--danger) 40%, transparent)"
          : isSelected
            ? "1px solid var(--accent-soft-border)"
            : "1px solid transparent",
        borderRadius: 8,
        transition: "background 0.1s, border-color 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "visible",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {t("deleteSessionConfirm", "Delete “{title}”?").replace(
              "{title}",
              `${title.slice(0, 22)}${title.length > 22 ? "…" : ""}`,
            )}
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                height: 32,
                padding: "0 11px",
                background: "#ef4444",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("delete", "Delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: 32,
                padding: "0 11px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("cancel", "Cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 13,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 34,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          <button
            type="button"
            onClick={() => {
              closeActionsMenu();
              onClick();
            }}
            aria-current={isSelected ? "page" : undefined}
            aria-label={
              isRunning
                ? `${title} · ${t("agentRunningStatus", "Agent running")}`
                : isUnread
                  ? `${title} · ${t("newSessionActivity", "New activity")}`
                  : title
            }
            style={{
              alignSelf: "stretch",
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: 0,
              border: 0,
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              font: "inherit",
              textAlign: "left",
            }}
          >
            {/* Fork indicator for child sessions */}
            {depth > 0 && (
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--text-dim)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
                aria-hidden="true"
              >
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  minWidth: 0,
                  fontSize: 13,
                  fontWeight: isSelected ? 600 : 500,
                  lineHeight: 1.4,
                  color: "var(--text)",
                }}
                title={
                  isRunning
                    ? `${title} · ${t("agentRunning", "Agent is running…")}`
                    : isUnread
                      ? `${title} · ${t("newSessionActivity", "New activity")}`
                      : title
                }
              >
                {isRunning ? (
                  <RunningSessionIndicator />
                ) : isUnread ? (
                  <UnreadSessionIndicator />
                ) : (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: isSelected ? "var(--success)" : "var(--text-dim)",
                      opacity: isSelected ? 1 : 0.55,
                    }}
                  />
                )}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                  {title}
                </span>
              </div>
              <div
                style={{
                  marginTop: 2,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  color: "var(--text-dim)",
                  fontSize: 12,
                  minWidth: 0,
                  paddingLeft: 13,
                }}
              >
                <span title={session.modified}>{formatRelativeDateTime(session.modified, language)}</span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--accent-chip-fg)",
                    background: "var(--accent-chip-bg)",
                    padding: "1px 6px",
                    borderRadius: 4,
                  }}
                >
                  {t("messageCount", "{count} msgs").replace("{count}", formatNumber(session.messageCount, language))}
                </span>
                {session.worktreeBranch && (
                  <span
                    title={t("worktreePath", "Worktree: {path}").replace("{path}", session.cwd)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                      color: "var(--accent)",
                      minWidth: 0,
                      overflow: "hidden",
                    }}
                  >
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: 0 }}
                    >
                      <line x1="6" y1="3" x2="6" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {session.worktreeBranch}
                    </span>
                  </span>
                )}
              </div>
            </div>
          </button>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleCollapse?.();
              }}
              title={collapsed ? t("expandForks", "Expand forks") : t("collapseForks", "Collapse forks")}
              aria-label={collapsed ? t("expandForks", "Expand forks") : t("collapseForks", "Collapse forks")}
              aria-expanded={!collapsed}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 32,
                height: 32,
                padding: 0,
                flexShrink: 0,
                background: hovered ? "var(--bg-hover)" : "none",
                border: "none",
                borderRadius: 7,
                color: "var(--text-dim)",
                cursor: "pointer",
                transition: "background 0.12s, color 0.12s",
              }}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{
                  transform: collapsed ? "rotate(-90deg)" : "none",
                  transition: "transform 0.15s",
                }}
              >
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          <button
            type="button"
            aria-label={t("deleteSessionConfirm", "Delete “{title}”?").replace("{title}", title)}
            title={t("deleteSessionConfirm", "Delete “{title}”?").replace("{title}", title)}
            onClick={handleDeleteClick}
            disabled={deleting}
            style={{
              background: "transparent",
              border: 0,
              padding: 6,
              color: "var(--text-dim)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="M3 6h18M5 6l1 14h12l1-14M9 6V3h6v3M10 10v6M14 10v6" />
            </svg>
          </button>

          <div
            ref={actionsRef}
            onBlur={(event) => {
              const nextFocus = event.relatedTarget as Node | null;
              if (nextFocus && (event.currentTarget.contains(nextFocus) || actionsMenuRef.current?.contains(nextFocus)))
                return;
              closeActionsMenu();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !actionsOpen) return;
              event.preventDefault();
              closeActionsMenu(true);
            }}
            style={{ position: "relative", flexShrink: 0 }}
          >
            <button
              type="button"
              ref={actionsSummaryRef}
              className="session-actions-summary"
              title={t("sessionActions", "Session actions")}
              aria-label={t("sessionActionsFor", "Session actions for {title}").replace("{title}", title)}
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              onClick={(event) => {
                event.stopPropagation();
                setActionsOpen((open) => {
                  if (!open) {
                    positionActionsMenu(event.currentTarget);
                    void loadProviderBindings();
                  }
                  return !open;
                });
              }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 32,
                height: 32,
                padding: 0,
                background: actionsOpen || hovered ? "var(--bg-hover)" : "transparent",
                border: actionsOpen ? "1px solid var(--border)" : "1px solid transparent",
                borderRadius: 7,
                color: actionsOpen ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.7" />
                <circle cx="12" cy="12" r="1.7" />
                <circle cx="19" cy="12" r="1.7" />
              </svg>
            </button>
            {actionsOpen &&
              menuPosition &&
              renderSessionMenuPortal(
                <div
                  ref={actionsMenuRef}
                  role="menu"
                  aria-label={t("sessionActions", "Session actions")}
                  style={{
                    position: "fixed",
                    top: menuPosition.top,
                    left: menuPosition.left,
                    zIndex: 500,
                    width: "min(280px, calc(100vw - 16px))",
                    maxHeight: "min(70vh, 440px)",
                    overflowY: "auto",
                    padding: 4,
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    background: "var(--bg)",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-item"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeActionsMenu();
                      void copyText(session.id);
                    }}
                    style={sessionMenuItemStyle}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    {t("copyPiSessionId", "Copy PI session ID")}
                  </button>
                  {modelBindings === null ? (
                    <div style={{ padding: "6px 9px", color: "var(--text-dim)", fontSize: 11 }}>正在加载模型会话…</div>
                  ) : modelBindings.length === 0 ? (
                    <div style={{ padding: "6px 9px", color: "var(--text-dim)", fontSize: 11 }}>暂无模型会话记录</div>
                  ) : (
                    modelBindings.map((binding) => (
                      <button
                        key={`${binding.model}:${binding.id}`}
                        type="button"
                        role="menuitem"
                        className="session-menu-item"
                        title={`${binding.model}\n${binding.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeActionsMenu();
                          void copyText(binding.id);
                        }}
                        style={sessionMenuItemStyle}
                      >
                        <span aria-hidden="true">#</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          复制 {binding.label} 会话 ID{binding.archived ? "（历史）" : binding.active ? "（当前）" : ""}
                        </span>
                      </button>
                    ))
                  )}
                  {providerBindings === null ? (
                    <div style={{ padding: "6px 9px", color: "var(--text-dim)", fontSize: 11 }}>正在加载网页会话…</div>
                  ) : providerBindings.length === 0 ? null : (
                    providerBindings.map((binding) => (
                      <div key={`${binding.modelId}:${binding.conversationId}`}>
                        <button
                          type="button"
                          role="menuitem"
                          className="session-menu-item"
                          title={binding.conversationId}
                          onClick={(event) => {
                            event.stopPropagation();
                            closeActionsMenu();
                            void copyText(binding.conversationId);
                          }}
                          style={sessionMenuItemStyle}
                        >
                          <span aria-hidden="true">#</span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {t("copyWebConversationId", "Copy {model} conversation ID").replace(
                              "{model}",
                              binding.modelId,
                            )}
                          </span>
                        </button>
                        {binding.conversationUrl && (
                          <button
                            type="button"
                            role="menuitem"
                            className="session-menu-item"
                            title={binding.conversationUrl}
                            onClick={(event) => {
                              event.stopPropagation();
                              closeActionsMenu();
                              void copyText(binding.conversationUrl!);
                            }}
                            style={sessionMenuItemStyle}
                          >
                            <span aria-hidden="true">↗</span>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {t("copyWebConversationUrl", "Copy {model} conversation URL").replace(
                                "{model}",
                                binding.modelId,
                              )}
                            </span>
                          </button>
                        )}
                      </div>
                    ))
                  )}
                  <div style={{ height: 1, margin: "4px", background: "var(--border)" }} />
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-item"
                    onClick={startRename}
                    style={sessionMenuItemStyle}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                    </svg>
                    {t("rename", "Rename")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-item"
                    onClick={handleDeleteClick}
                    style={{ ...sessionMenuItemStyle, color: "var(--danger)" }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                    {t("delete", "Delete")}
                  </button>
                  <div style={{ height: 1, margin: "4px", background: "var(--border)" }} />
                  <div style={{ padding: "4px 9px 6px", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.6 }}>
                    <div title={session.created}>创建：{formatDateTime(session.created, language)}</div>
                    <div title={session.modified}>更新：{formatDateTime(session.modified, language)}</div>
                  </div>
                </div>,
              )}
          </div>
        </>
      )}
    </div>
  );
}
