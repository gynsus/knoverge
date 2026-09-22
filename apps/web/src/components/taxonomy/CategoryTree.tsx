import type { CategorySummary } from '@knoverge/contracts';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { CategoryNode } from '@/lib/taxonomy-tree';
import { cn } from '@/lib/utils';

export interface TreeActions {
  onSelect: (category: CategorySummary) => void;
  onAddChild: (parent: CategorySummary) => void;
  onEdit: (category: CategorySummary) => void;
  onMove: (category: CategorySummary) => void;
  onMerge: (category: CategorySummary) => void;
  onArchive: (category: CategorySummary) => void;
  onRestore: (category: CategorySummary) => void;
  /** False for somebody who may read the taxonomy and not change it. */
  canManage: boolean;
}

export interface CategoryTreeProps extends TreeActions {
  nodes: readonly CategoryNode[];
  selectedId: string | null;
  /** Which categories are open. A search opens the ancestors of its matches. */
  expanded: ReadonlySet<string>;
  onToggle: (id: string, open: boolean) => void;
  /** Ids a search matched, for the highlight. Empty when nothing is searched. */
  matched: ReadonlySet<string>;
  /** Ids a search leaves on screen. Empty means show everything. */
  visible: ReadonlySet<string>;
}

export function CategoryTree(props: CategoryTreeProps) {
  const { t } = useTranslation();
  return (
    <ul aria-label={t('taxonomy.structure')} className="grid gap-0.5 p-2">
      {props.nodes.map((node) => (
        <TreeNode key={node.category.id} node={node} level={0} {...props} />
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  level,
  ...props
}: { node: CategoryNode; level: number } & Omit<CategoryTreeProps, 'nodes'>) {
  const { t } = useTranslation();
  const category = node.category;
  const filtering = props.visible.size > 0;
  if (filtering && !props.visible.has(category.id)) return null;

  const children = node.children.filter(
    (child) => !filtering || props.visible.has(child.category.id),
  );
  const hasChildren = children.length > 0;
  const open = props.expanded.has(category.id);
  const archived = category.status === 'archived';
  const merged = category.status === 'merged';

  return (
    <li>
      <Collapsible open={open} onOpenChange={(next) => props.onToggle(category.id, next)}>
        <div
          className={cn(
            'group flex h-10 items-center gap-1 rounded-md pr-2',
            'hover:bg-muted',
            props.selectedId === category.id && 'bg-muted',
            props.matched.has(category.id) && 'ring-1 ring-primary ring-inset',
          )}
          // Indentation is the hierarchy. An inline value rather than a class
          // because the depth is not known at build time and Tailwind only
          // emits classes it can see in the source.
          style={{ paddingLeft: `${level * 20 + 8}px` }}
        >
          {hasChildren ? (
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={
                  open
                    ? t('taxonomy.collapse', { name: category.name })
                    : t('taxonomy.expand', { name: category.name })
                }
                className="size-7 shrink-0 px-0"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn('size-4 transition-transform', open && 'rotate-90')}
                />
              </Button>
            </CollapsibleTrigger>
          ) : (
            // Keeps every name on the same left edge whether or not it has
            // children, which is what makes a column of them readable.
            <span aria-hidden="true" className="size-7 shrink-0" />
          )}

          <button
            type="button"
            onClick={() => props.onSelect(category)}
            aria-current={props.selectedId === category.id ? 'true' : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span
              className={cn(
                'truncate text-sm font-medium',
                (archived || merged) && 'text-muted-foreground line-through',
              )}
            >
              {category.name}
            </span>
            {archived && (
              <Badge variant="outline" className="shrink-0">
                {t('taxonomy.statuses.archived')}
              </Badge>
            )}
            {merged && (
              <Badge variant="outline" className="shrink-0">
                {t('taxonomy.statuses.merged')}
              </Badge>
            )}
          </button>

          {/* The subtree number, because a branch's weight is what somebody is
              looking for when they scan a tree. */}
          <span
            className="shrink-0 text-xs tabular-nums text-muted-foreground"
            title={t('taxonomy.items_in_branch', { count: category.subtree_item_count })}
          >
            {category.subtree_item_count}
          </span>

          {props.canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('taxonomy.actions', { name: category.name })}
                  // Visible on hover for a pointer, and always once focused,
                  // because a keyboard has no hover and would never reach it.
                  className="size-7 shrink-0 px-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                >
                  <MoreHorizontal aria-hidden="true" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {category.status === 'active' ? (
                  <>
                    <DropdownMenuItem onSelect={() => props.onAddChild(category)}>
                      {t('taxonomy.add_child')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => props.onEdit(category)}>
                      {t('taxonomy.edit')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => props.onMove(category)}>
                      {t('taxonomy.move')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => props.onMerge(category)}>
                      {t('taxonomy.merge')}
                    </DropdownMenuItem>
                    {/* Archive rather than delete: a category holds knowledge,
                        and nothing here should be able to take it with it. */}
                    <DropdownMenuItem onSelect={() => props.onArchive(category)}>
                      {t('taxonomy.archive')}
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem disabled={merged} onSelect={() => props.onRestore(category)}>
                    {t('taxonomy.restore')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasChildren && (
          <CollapsibleContent asChild>
            <ul className="grid gap-0.5">
              {children.map((child) => (
                <TreeNode key={child.category.id} node={child} level={level + 1} {...props} />
              ))}
            </ul>
          </CollapsibleContent>
        )}
      </Collapsible>
    </li>
  );
}
