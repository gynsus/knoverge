import type { MemberSummary, MembershipRole } from '@knoverge/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { adminApi } from '../api/admin.ts';
import { useAuth } from '../auth/use-auth.ts';
import { useWorkspaceContext } from '../auth/use-workspace.ts';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Field, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableActions,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ErrorNotice } from '../components/ErrorNotice.tsx';

// Its own key space. ['workspace', 'members'] shares one with the context's
// ['workspace', <id>], so the two would invalidate each other by accident.
const MEMBERS_KEY = ['workspace-members'] as const;
const ROLES: MembershipRole[] = ['owner', 'admin', 'reviewer', 'viewer'];

function MemberRow({
  member,
  onChanged,
  isSelf,
}: {
  member: MemberSummary;
  onChanged: () => Promise<void>;
  isSelf: boolean;
}) {
  const { t, i18n } = useTranslation();
  // A role change is held here until it is applied. Two reasons: the select is
  // controlled by server data, so without it the control visibly reverts to the
  // old role while the change is in flight; and changing what somebody may do
  // should not happen on a stray keystroke over a dropdown.
  const [pendingRole, setPendingRole] = useState<MembershipRole | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const update = useMutation({
    mutationFn: (role: MembershipRole) =>
      adminApi.workspace.updateMember({ user_id: member.user_id, role }),
    onSuccess: async () => {
      await onChanged();
      setPendingRole(null);
    },
  });
  const remove = useMutation({
    mutationFn: () => adminApi.workspace.removeMember(member.user_id),
    onSuccess: onChanged,
  });
  const resetPassword = useMutation({
    mutationFn: () => adminApi.workspace.resetMemberPassword(member.user_id, newPassword),
    onSuccess: async () => {
      setResetting(false);
      setNewPassword('');
      await onChanged();
    },
  });
  const role = pendingRole ?? member.role;
  return (
    <TableRow>
      <TableCell label={t('workspace.person')}>
        <span>{member.display_name}</span> <code>{member.email}</code>
      </TableCell>
      <TableCell label={t('workspace.role')}>
        <Select
          value={role}
          aria-label={t('workspace.role_of', { name: member.display_name })}
          onChange={(e) => setPendingRole(e.target.value as MembershipRole)}
          disabled={update.isPending || isSelf}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`roles.${r}`)}
            </option>
          ))}
        </Select>
        {pendingRole !== null && pendingRole !== member.role && (
          <TableActions>
            <Button
              type="button"
              onClick={() => update.mutate(pendingRole)}
              disabled={update.isPending}
            >
              {update.isPending ? t('common.working') : t('workspace.apply_role')}
            </Button>
            <Button variant="outline" type="button" onClick={() => setPendingRole(null)}>
              {t('common.cancel')}
            </Button>
          </TableActions>
        )}
      </TableCell>
      <TableCell label={t('workspace.last_seen')}>
        {member.last_login_at
          ? new Date(member.last_login_at).toLocaleDateString(i18n.language)
          : t('workspace.never_signed_in')}
      </TableCell>
      <TableCell label={t('common.actions')}>
        {isSelf ? (
          <span>
            <small>{t('workspace.this_is_you')}</small>
          </span>
        ) : resetting ? (
          <TableActions>
            <label className="sr-only" htmlFor={`reset-${member.user_id}`}>
              {t('workspace.new_password')}
            </label>
            <Input
              id={`reset-${member.user_id}`}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={12}
              autoComplete="new-password"
              placeholder={t('workspace.new_password')}
              className="w-48"
            />
            <Button
              type="button"
              onClick={() => resetPassword.mutate()}
              disabled={resetPassword.isPending || newPassword.length < 12}
            >
              {resetPassword.isPending ? t('common.working') : t('workspace.confirm')}
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                setResetting(false);
                setNewPassword('');
              }}
            >
              {t('common.cancel')}
            </Button>
          </TableActions>
        ) : confirmingRemoval ? (
          <TableActions>
            <span className="text-sm">
              {t('workspace.confirm_remove', { name: member.display_name })}
            </span>
            <Button
              variant="destructive"
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending ? t('common.working') : t('workspace.confirm')}
            </Button>
            <Button variant="outline" type="button" onClick={() => setConfirmingRemoval(false)}>
              {t('common.cancel')}
            </Button>
          </TableActions>
        ) : (
          <TableActions>
            {/* No mail server, so a reset is a password handed over out of
                band — the same way a member is added in the first place. */}
            <Button type="button" onClick={() => setResetting(true)}>
              {t('workspace.reset_password')}
            </Button>
            <Button type="button" onClick={() => setConfirmingRemoval(true)}>
              {t('workspace.remove')}
            </Button>
          </TableActions>
        )}
        <ErrorNotice error={update.error ?? remove.error ?? resetPassword.error} />
      </TableCell>
    </TableRow>
  );
}

/**
 * Who reaches this workspace.
 *
 * The workspace's own settings are edited in a drawer on the list, where
 * every workspace is: a form on a page of its own could only ever change the
 * one you happened to be in, which is not where somebody arrives wanting to
 * rename a different one.
 */
export function WorkspacePage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const workspaces = useWorkspaceContext();
  const auth = useAuth();
  const myUserId = auth.state.kind === 'authenticated' ? auth.state.me.user.id : undefined;
  const [email, setEmail] = useState('');
  const [memberName, setMemberName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<MembershipRole>('reviewer');

  const members = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: ({ signal }) => adminApi.workspace.members(signal),
    retry: false,
  });

  const refreshMembers = async () => {
    await client.invalidateQueries({ queryKey: MEMBERS_KEY });
  };

  const addMember = useMutation({
    mutationFn: () =>
      adminApi.workspace.addMember({
        email,
        role,
        ...(memberName ? { display_name: memberName } : {}),
        ...(password ? { initial_password: password } : {}),
      }),
    onSuccess: async () => {
      setEmail('');
      setMemberName('');
      setPassword('');
      await refreshMembers();
    },
  });

  const submitMember = (event: FormEvent) => {
    event.preventDefault();
    addMember.mutate();
  };

  // The server gates on the permission, so the interface asks the same
  // question. Deriving it from the role showed a disabled form to a reviewer
  // who had been granted workspace administration explicitly.
  const canAdminister = workspaces.can('workspace.admin');

  return (
    <>
      <div className="grid gap-1.5">
        <h2 className="text-2xl font-semibold tracking-tight">{t('workspace.members')}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('workspace.members_intro', { name: workspaces.workspace?.name ?? '' })}
        </p>
        {/* The same request the shell already made, read from the context
            rather than fetched again under a second key. */}
        {workspaces.isPending && <p role="status">{t('common.loading')}</p>}
        <ErrorNotice error={workspaces.error} />
      </div>

      {!canAdminister && <p>{t('workspace.members_forbidden')}</p>}

      {canAdminister && (
        <>
          {/* No title of its own: the page heading above says Members, and
              two headings of the same name is one more than a reader needs. */}
          <Card aria-label={t('workspace.members')} className="grid gap-3 p-4 sm:p-6">
            {members.isPending && <p role="status">{t('common.loading')}</p>}
            {members.isError && <ErrorNotice error={members.error} />}
            {members.data && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('workspace.person')}</TableHead>
                    <TableHead>{t('workspace.role')}</TableHead>
                    <TableHead>{t('workspace.last_seen')}</TableHead>
                    <TableHead>
                      <span className="sr-only">{t('common.actions')}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.data.members.map((member) => (
                    <MemberRow
                      key={member.user_id}
                      member={member}
                      onChanged={refreshMembers}
                      // Changing your own role and removing yourself are both
                      // refused by the server, so the controls are not offered.
                      isSelf={member.user_id === myUserId}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <Card aria-labelledby="add-member-title" className="grid gap-3 p-4 sm:p-6">
            <CardTitle id="add-member-title">{t('workspace.add_member')}</CardTitle>
            <p>{t('workspace.add_member_intro')}</p>
            <form onSubmit={submitMember} className="grid gap-4">
              <FieldSet disabled={addMember.isPending}>
                <Field label={t('fields.email')}>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </Field>
                <Field label={t('fields.display_name')} hint={t('workspace.display_name_hint')}>
                  <Input value={memberName} onChange={(e) => setMemberName(e.target.value)} />
                </Field>
                <Field
                  label={t('workspace.initial_password')}
                  hint={t('workspace.initial_password_hint')}
                >
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={12}
                    autoComplete="new-password"
                  />
                </Field>
                <Field label={t('workspace.role')}>
                  <Select value={role} onChange={(e) => setRole(e.target.value as MembershipRole)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`roles.${r}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FieldSet>
              <ErrorNotice error={addMember.error} />
              <Button type="submit" disabled={addMember.isPending} className="justify-self-start">
                {addMember.isPending ? t('common.working') : t('workspace.add')}
              </Button>
            </form>
          </Card>
        </>
      )}
    </>
  );
}
