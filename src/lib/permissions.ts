// Role-based permissions helper.
//
// Roles:
//   - admin:   full access to everything, including Settings.
//   - manager: access to all modules; no Settings.
//   - viewer:  access limited to modules listed in allowedModules[]. No
//              import, no Settings.

import type { AppModule, NavItem } from "@/lib/modules";

export interface UserPermissions {
  role: "admin" | "manager" | "viewer";
  allowedModules?: string[];
}

/** Can this user open this module at all? */
export function canAccessModule(
  user: UserPermissions | null,
  moduleId: string
): boolean {
  if (!user) return false;
  if (user.role === "admin" || user.role === "manager") return true;
  if (user.role === "viewer") {
    return (user.allowedModules ?? []).includes(moduleId);
  }
  return false;
}

/** Can this user upload new imports for this module? */
export function canImport(user: UserPermissions | null): boolean {
  if (!user) return false;
  return user.role === "admin" || user.role === "manager";
}

/** Can this user see admin Settings? */
export function canAccessSettings(user: UserPermissions | null): boolean {
  return user?.role === "admin";
}

/** Return the subset of modules this user can see in the nav/home. */
export function visibleModules(
  user: UserPermissions | null,
  modules: AppModule[]
): AppModule[] {
  return modules.filter((m) => canAccessModule(user, m.id));
}

/** Within an accessible module, filter the nav items a user should see. */
export function visibleNavItems(
  user: UserPermissions | null,
  mod: AppModule
): NavItem[] {
  if (canImport(user)) return mod.navItems;
  // Viewers don't get the Import link.
  return mod.navItems.filter((n) => n.href !== mod.importRoute);
}
