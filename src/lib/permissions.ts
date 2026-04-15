// Role-based permissions helper.
//
// Roles:
//   - admin:   full access to everything, including Settings.
//   - viewer:  full access to the modules listed in allowedModules — this
//              means they can open the pages, import new reports, and
//              delete reports for any module they're assigned to. They
//              cannot see Settings and cannot touch modules they aren't
//              assigned to.
//   - manager: LEGACY. Older user docs may still have this role while
//              migration has not yet run. Treated as admin for all gates
//              below; auth-context migrates the doc to "admin" on next
//              sign-in, after which this branch is unused.

import type { AppModule, NavItem } from "@/lib/modules";

export interface UserPermissions {
  role: "admin" | "viewer" | "manager";
  allowedModules?: string[];
}

function isAdminLike(user: UserPermissions | null): boolean {
  // Legacy "manager" docs are treated as admin until auth-context migrates
  // them. Once migrated, this branch is dead.
  return user?.role === "admin" || user?.role === "manager";
}

export function canAccessModule(
  user: UserPermissions | null,
  moduleId: string
): boolean {
  if (!user) return false;
  if (isAdminLike(user)) return true;
  if (user.role === "viewer") {
    return (user.allowedModules ?? []).includes(moduleId);
  }
  return false;
}

/** Can this user import new reports for `moduleId`? */
export function canImport(
  user: UserPermissions | null,
  moduleId: string
): boolean {
  return canAccessModule(user, moduleId);
}

/** Can this user delete a report in `moduleId`? */
export function canDeleteReport(
  user: UserPermissions | null,
  moduleId: string
): boolean {
  return canAccessModule(user, moduleId);
}

/** Can this user see the admin Settings page? */
export function canAccessSettings(user: UserPermissions | null): boolean {
  return isAdminLike(user);
}

/** Modules visible to this user in the nav/home. */
export function visibleModules(
  user: UserPermissions | null,
  modules: AppModule[]
): AppModule[] {
  return modules.filter((m) => canAccessModule(user, m.id));
}

/**
 * All nav items within a visible module. (Previously filtered out the
 * Import link for viewers; now viewers get full module access so nothing
 * is filtered here.)
 */
export function visibleNavItems(
  _user: UserPermissions | null,
  mod: AppModule
): NavItem[] {
  return mod.navItems;
}
