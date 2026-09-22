# Terms of use

Version: 2026-09-22

These terms cover Knoverge, the software. They are shown when an installation
is first set up, and the person setting it up accepts them on behalf of
whoever will operate that installation.

The same clauses appear in the application, in every language it is
translated into. This file is the English original.

They are written to be read rather than to be impressive, and they are not
legal advice. An operator whose situation calls for it should have them
reviewed, and is free to replace them: this is your installation.

## 1. Free, and as is

Knoverge is free and open-source software, published under the Apache License
2.0. A copy is in `LICENSE`, and it governs the software itself.

It is provided **as is**, without warranty of any kind. Nobody promises that
it is fit for your purpose, that it will keep running, or that it is free of
defects.

## 2. Nobody is liable for what it does to your data

To the fullest extent the law allows, the authors and contributors are not
liable for any loss or damage arising from using this software — including
lost, corrupted or disclosed knowledge, and including cases where somebody
had been warned it was possible.

This is not a formality. The software is under development, it writes to a
Git repository and a database, and a defect in either direction can lose
work.

## 3. You run it, so you are responsible for it

You choose where it runs, who can reach it, what goes into it and who is
allowed to see it. That makes you responsible for:

- keeping it secure, patched and behind whatever network protection it needs;
- **backups, and testing that they restore**;
- what is recorded in it, and the rights you have to record it;
- meeting any legal obligation that applies to you, including data protection
  law, in your jurisdiction and your users'.

The software helps: it records who changed what, keeps history in Git, and
ships with backup and restore tooling. None of that is a substitute for an
operator who checks.

## 4. Nothing is sent anywhere

The server contacts no external service unless you configure one. There is no
telemetry, no analytics, and no usage reporting — not off by default, but
absent.

## 5. AI features are optional, and send data where you point them

Language-model features are off unless you configure a provider. If you do,
the knowledge you send to that feature goes to that provider, under that
provider's terms and privacy policy, and this document has nothing to say
about what they do with it. Everything the software needs to do its job works
without any provider at all.

## 6. Agents act with the authority you give them

An agent connected to a workspace can read and propose within the permissions
you grant it, and can write directly if you add a policy rule that allows it.
What an agent records is attributable to that agent, and reviewing it is your
decision to make or to delegate.

## 7. No service, no support, no uptime

This is software you run, not a service anybody operates for you. There is no
support obligation, no response time, and no uptime commitment. Questions are
welcome in the project's issue tracker and are answered when somebody has
time.

## 8. These terms can change

A later version of the software may ship later terms. Changes apply from the
version you upgrade to; they do not reach back. You are free to amend them
for your own installation, and your own users are then your concern rather
than this project's.

## 9. Accepting them

The installation records which version of these terms was accepted, by whom
and when, so that an operator can answer that question later. That record is
kept locally, like everything else.
