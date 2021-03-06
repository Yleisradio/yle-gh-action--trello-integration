import * as core from '@actions/core';
import * as github from '@actions/github';

import {
  getLabelsOfBoard,
  getMembersOfBoard,
  getCardsOfListOrBoard,
  createCard,
  updateCard,
  getCardAttachments,
  addAttachmentToCard,
} from './api';
import { TrelloCard, TrelloCardRequestParams } from './types';
import { validateListExistsOnBoard } from './utils';

const verbose: string | boolean = process.env.TRELLO_ACTION_VERBOSE || false;
const action = core.getInput('action');

/**
 * GW webhook payload.
 *
 * @see https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#webhook-payload-example-48
 */
const ghPayload: any = github.context.payload;

if (!action) {
  throw Error('Action is not set.');
}

try {
  switch (action) {
    case 'issue_opened_create_card':
      issueOpenedCreateCard();
      break;
    case 'pull_request_event_move_card':
      pullRequestEventMoveCard();
      break;

    default:
      throw Error('Action is not supported: ' + action);
  }
} catch (error) {
  core.setFailed(error as Error);
}

function issueOpenedCreateCard() {
  const issue = ghPayload.issue;
  const issueNumber = issue?.number;
  const issueTitle = issue?.title;
  const issueBody = issue?.body;
  const issueUrl = issue?.html_url;
  const issueAssigneeNicks = issue?.assignees.map((assignee: any) => assignee.login);
  const issueLabelNames = issue?.labels.map((label: any) => label.name);
  const listId: string = process.env.TRELLO_LIST_ID as string;
  const trelloLabelIds: string[] = [];
  const memberIds: string[] = [];

  if (!validateListExistsOnBoard(listId)) {
    core.setFailed('TRELLO_LIST_ID is not valid.');
    return;
  }

  const getLabels = getLabelsOfBoard().then((trelloLabels) => {
    if (typeof trelloLabels === 'string') {
      core.setFailed(trelloLabels);
      return;
    }
    const intersection = trelloLabels.filter((label) => issueLabelNames.includes(label.name));
    const matchingLabelIds = intersection.map((trelloLabel) => trelloLabel.id);
    trelloLabelIds.push(...matchingLabelIds);
  });

  const getMembers = getMembersOfBoard().then((trelloMembers) => {
    if (typeof trelloMembers === 'string') {
      core.setFailed(trelloMembers);
      return;
    }
    const membersOnBothSides = trelloMembers.filter((member) =>
      issueAssigneeNicks.includes(member.username),
    );
    const matchingMemberIds = membersOnBothSides.map((trelloMember) => trelloMember.id);
    memberIds.push(...matchingMemberIds);
  });

  Promise.all([getLabels, getMembers]).then(() => {
    const params = {
      number: issueNumber,
      title: issueTitle,
      description: issueBody,
      sourceUrl: issueUrl,
      memberIds: memberIds.join(),
      labelIds: trelloLabelIds.join(),
    } as unknown as TrelloCardRequestParams;

    if (verbose) {
      console.log(`Creating new card to ${listId} from issue  "[#${issueNumber}] ${issueTitle}"`);
    }
    // No need to create the attachment for this repository separately since the createCard()
    // adds the backlink to the created issue, see
    // params.sourceUrl property.
    createCard(listId, params).then((createdCard) => {
      if (typeof createdCard === 'string') {
        core.setFailed(createdCard);
        return;
      }

      if (verbose) {
        console.log(
          `Card created: "[#${issueNumber}] ${issueTitle}], url ${createdCard.shortUrl}"`,
        );
      }
    });
  });
}

function pullRequestEventMoveCard() {
  const pullRequest = ghPayload.pull_request;
  const repoHtmlUrl = github.context.payload.repository?.html_url || 'URL missing in GH payload';

  const sourceList: string = process.env.TRELLO_SOURCE_LIST_ID as string;
  const targetList: string = process.env.TRELLO_TARGET_LIST_ID as string;
  const additionalMemberIds: string[] = [];

  if (
    (sourceList && !validateListExistsOnBoard(sourceList)) ||
    !targetList ||
    !validateListExistsOnBoard(targetList)
  ) {
    core.setFailed('TRELLO_SOURCE_LIST_ID or TRELLO_TARGET_LIST_ID is invalid.');
    return;
  }

  // TODO: Allow unspecified target as well so that - say - PR moves card to "Ready for review"
  // list regardless of where it is currently.
  getCardsOfListOrBoard(sourceList)
    .then((cardsOnList) => {
      // Filter cards to those which refer to the Github Issues mentioned in the PR.
      if (typeof cardsOnList === 'string') {
        core.setFailed(cardsOnList);
        return [];
      }
      const referencedIssuesInGh: string[] = pullRequest?.body?.match(/#[1-9][0-9]*/) || [];

      return cardsOnList
        .filter((card) => {
          const haystack = `${card.name} ${card.desc}`;
          const issueRefsOnCurrentCard = haystack.match(/#[1-9][0-9]*/) || [];

          const crossMatchIssues = issueRefsOnCurrentCard.filter((issueRef) =>
            referencedIssuesInGh.includes(issueRef),
          );
          return crossMatchIssues.length !== 0;
        })
        .filter((card) => {
          // Filter cards to those which refer to the Github repository via any attachment.
          // Note that link in card.desc is not satisfactory.
          return getCardAttachments(card.id).then((attachments) => {
            if (typeof attachments === 'string') {
              return false;
            }

            attachments.find((attachment) => attachment.url.startsWith(repoHtmlUrl));
            return attachments.length !== 0;
          });
        });
    })
    // Final list of cards that need to be moved to target list.
    .then((cardsToBeMoved) => {
      const params = {
        destinationListId: targetList,
        memberIds: additionalMemberIds.join(),
      };
      cardsToBeMoved.forEach((card) => {
        if (verbose) {
          console.log(`Moving card "${card.name}" to board to ${targetList}.`);
        }
        updateCard(card.id, params)
          .then((trelloCard) => {
            if (typeof trelloCard === 'string') {
              core.setFailed(trelloCard);
              return;
            }

            if (verbose) {
              console.log(`Card "${card.name}" moved to board ${targetList}.`);
            }

            // Check if the PR is already linked from the Card.
            // Card has attachments and we are satisfied if the beginning of
            // any attachment url matches the public repository URL.
            const cardHasPrLinked = (card: TrelloCard) => {
              return getCardAttachments(card.id).then((attachments) => {
                if (typeof attachments === 'string') {
                  return false;
                }

                const matchingAttachment = attachments.find((attachment) =>
                  attachment.url.startsWith(repoHtmlUrl),
                );
                if (typeof matchingAttachment !== 'undefined') {
                  if (verbose) {
                    console.log(
                      `Adding link (attachment) to pull request to the card "${card.name}".`,
                    );
                  }
                  return true;
                }
                return false;
              });
            };

            // Create the backlink to PR only if it is not there yet.
            !cardHasPrLinked(card) &&
              addAttachmentToCard(card.id, pullRequest?.html_url || '').then((attachment) => {
                if (typeof attachment === 'string') {
                  core.setFailed(attachment);
                  return;
                }
                if (verbose) {
                  console.log(
                    `Link (attachment) to pull request URL ${attachment.url} added to the card "${card.name}".`,
                  );
                }
              });
          })
          .catch((error) => {
            console.error(error);
            core.setFailed('Something went wrong when querying Cards to be moved.');
            return [];
          });
      });
    });
}
