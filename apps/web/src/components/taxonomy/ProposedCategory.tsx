import type { CategorySummary, ProposalDetail } from '@knoverge/contracts';
import { useMutation } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { relativeTime } from '@/lib/relative-time';
import { adminApi } from '../../api/admin.ts';
import { ErrorNotice } from '../ErrorNotice.tsx';
import { payloadOf, similarTo, type ProposedPayload } from './proposed-category.ts';

/**
 * A category an agent has asked for, and the decision about it.
 *
 * Approving is not offered. Making the category out of the proposal is the
 * taxonomy service's own create, and the review workflow does not reach it
 * yet — so the button that exists is the one that works, and the one that
 * does not is a sentence saying what to do instead.
 */
export function ProposedCategory({
  proposal,
  proposer,
  categories,
  onCreate,
  onResolved,
}: {
  proposal: ProposalDetail;
  proposer: string;
  categories: readonly CategorySummary[];
  /** Opens the create form with this proposal's answers already in it. */
  onCreate: (payload: ProposedPayload) => void;
  onResolved: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const payload = payloadOf(proposal);
  const similar = similarTo(payload.name, categories);

  const reject = useMutation({
    mutationFn: () =>
      adminApi.proposals.reject({
        proposal_id: proposal.id,
        reason: t('taxonomy.proposal_rejected_reason'),
      }),
    onSuccess: onResolved,
  });

  return (
    <div className="grid content-start gap-5 p-4 sm:p-6">
      <header className="grid gap-2">
        <h3 className="text-lg font-semibold tracking-tight">{payload.name}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-normal">
            {t('taxonomy.proposed')}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {t('taxonomy.proposed_by', {
              name: proposer,
              when: relativeTime(proposal.created_at, i18n.language),
            })}
          </span>
        </div>
        <p className="font-mono text-xs break-all text-muted-foreground">
          {payload.parentPath ? `${payload.parentPath}/…` : t('taxonomy.at_the_root')}
        </p>
      </header>

      {proposal.reason && (
        <section className="grid gap-1">
          <h4 className="text-sm font-medium">{t('taxonomy.why_proposed')}</h4>
          <p className="text-sm text-muted-foreground">{proposal.reason}</p>
        </section>
      )}

      {payload.description && (
        <section className="grid gap-1">
          <h4 className="text-sm font-medium">{t('taxonomy.description')}</h4>
          <p className="text-sm text-muted-foreground">{payload.description}</p>
        </section>
      )}

      {/* What would be filed here. The case for a category is the material
          that has nowhere else to go. */}
      {payload.exampleTitles.length > 0 && (
        <section className="grid gap-1">
          <h4 className="text-sm font-medium">{t('taxonomy.what_would_go_here')}</h4>
          <ul className="grid gap-0.5 text-sm text-muted-foreground">
            {payload.exampleTitles.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        </section>
      )}

      {similar.length > 0 && (
        <section className="grid gap-1">
          <h4 className="text-sm font-medium">{t('taxonomy.already_close')}</h4>
          <p className="text-xs text-muted-foreground">{t('taxonomy.already_close_hint')}</p>
          <ul className="grid gap-0.5 text-sm">
            {similar.map((category) => (
              <li key={category.id}>
                {category.name}
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {category.path}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ErrorNotice error={reject.error} />

      <div className="grid gap-2">
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => onCreate(payload)}>
            <Plus aria-hidden="true" className="size-4" />
            {t('taxonomy.create_from_proposal')}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-destructive"
            disabled={reject.isPending}
            onClick={() => reject.mutate()}
          >
            <X aria-hidden="true" className="size-4" />
            {t('taxonomy.reject_proposal')}
          </Button>
        </div>
        {/* Said rather than left to be discovered by pressing something that
            refuses: approving a category proposal does not make the category
            yet, and the reviewer makes it themselves. */}
        <p className="text-xs text-muted-foreground">{t('taxonomy.proposal_flow_hint')}</p>
      </div>
    </div>
  );
}
