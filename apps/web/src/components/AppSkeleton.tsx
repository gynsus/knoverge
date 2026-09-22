import { useTranslation } from 'react-i18next';

import { Card } from '@/components/ui/card';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * How many navigation rows to stand in for.
 *
 * The real number depends on what the caller may do — between three and
 * eight — and is not known until the session answers. Five is the middle of
 * that range, so the list settles by a row or two either way rather than
 * appearing from nothing.
 */
const NAV_ROWS = 5;

/**
 * The application before the session has answered.
 *
 * Built from the real sidebar rather than from divs shaped like one, so the
 * widths, the borders and the breakpoints are the same ones the loaded
 * interface uses: when the content arrives, the chrome around it does not
 * move.
 *
 * What it does not do is guess. The chrome is real because it is the same for
 * everybody; the rows inside it are blank because their number and their names
 * depend on who is signing in and which workspace they land in. A placeholder
 * that guessed "Knowledge, Review, Taxonomy" would be showing a viewer
 * sections they will never be offered.
 */
export function AppSkeleton() {
  const { t } = useTranslation();
  return (
    <SidebarProvider>
      {/* One statement of what is happening, for a reader who cannot see the
          placeholders. `aria-busy` marks the region rather than the document,
          so assistive technology can move on and come back. */}
      <div role="status" aria-busy="true" className="sr-only">
        {t('common.loading')}
      </div>
      <Sidebar collapsible="icon">
        <SidebarHeader className="gap-2 px-2 py-3">
          <Skeleton className="mx-2 h-3 w-20 group-data-[collapsible=icon]:hidden" />
          <div className="flex items-center gap-2 p-2">
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <div className="grid flex-1 gap-1.5 group-data-[collapsible=icon]:hidden">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {Array.from({ length: NAV_ROWS }, (_, row) => (
                  <SidebarMenuItem key={row}>
                    <div className="flex h-8 items-center gap-2 p-2">
                      <Skeleton className="size-4 shrink-0" />
                      {/* Uneven widths, because a column of identical bars
                          reads as a table rather than as a list of names. */}
                      <Skeleton
                        className="h-3 group-data-[collapsible=icon]:hidden"
                        style={{ width: `${[68, 54, 80, 60, 72][row % 5]}px` }}
                      />
                    </div>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="gap-2 px-3 py-3 group-data-[collapsible=icon]:px-1">
          <Skeleton className="h-3.5 w-24 group-data-[collapsible=icon]:hidden" />
          <Skeleton className="h-8 w-full group-data-[collapsible=icon]:size-8" />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex items-center gap-2 border-b border-border px-4 py-2">
          <Skeleton className="size-7 shrink-0" />
          <Skeleton className="h-4 w-32" />
        </header>
        <MainSkeleton />
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * The page area alone, for when the chrome is already on screen.
 *
 * Two cards rather than one: every page here is a stack of them, and a single
 * block in the middle of the screen looks like the content itself rather than
 * like its outline.
 */
export function MainSkeleton() {
  return (
    <div className="grid gap-4 p-4 sm:p-6">
      {[0, 1].map((card) => (
        <Card key={card} className="grid gap-3 p-4 sm:p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-full max-w-lg" />
          <Skeleton className="h-3.5 w-full max-w-md" />
        </Card>
      ))}
    </div>
  );
}
