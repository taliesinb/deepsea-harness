/**
 * The relocation actions: Move to… and Copy to…, two
 * `sidebar.workspaces.session.menu.item` rows that raise a relocation request. The dialog answering it is browser-owned (it
 * shares the browser's directory-flow hole, so a fresh directory can be the
 * destination); the browser raises the same request when a drop on another
 * Workspace is refused.
 */
import { IconCopyOutlineRegular, IconRightUpOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RelocateSessionInjected, SessionMenuItemProps } from '../contract/slots.ts'

/**
 * Menu row (order 350): Move to…, asking for the destination dialog.
 * @param props - owner share, menu open state, and the relocation share.
 * @returns the row.
 */
export function MoveSessionMenuItem({
  sessionId, displayTitle, useMenuOpenState, requestSessionRelocation, t,
}: SessionMenuItemProps<RelocateSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      icon={<IconRightUpOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        requestSessionRelocation({ action: 'move', sessionId, displayTitle })
      }}
    >
      {t('menu.moveSession')}
    </MenuItemButton>
  )
}

/**
 * Menu row (order 360): Copy to…, asking for the destination dialog; the
 * Session's own Workspace is preselected (a duplicate).
 * @param props - owner share, menu open state, and the relocation share.
 * @returns the row.
 */
export function CopySessionMenuItem({
  sessionId, displayTitle, useMenuOpenState, requestSessionRelocation, t,
}: SessionMenuItemProps<RelocateSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      icon={<IconCopyOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        requestSessionRelocation({ action: 'copy', sessionId, displayTitle })
      }}
    >
      {t('menu.copySession')}
    </MenuItemButton>
  )
}
