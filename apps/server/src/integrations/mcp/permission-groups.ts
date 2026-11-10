import type { McpCapabilityName } from './permissions.js';

export type McpPermissionGroup = {
  name: string;
  title: string;
  description: string;
  read: readonly McpCapabilityName[];
  write: readonly McpCapabilityName[];
};

// group the fixed tool surface into simple user-facing read and write controls
export const mcpPermissionGroups = [
  {
    name: 'notes',
    title: 'Notes',
    description: 'Read lists notes and gets their contents.\nWrite creates, renames, edits, and deletes notes, and manages attachments and schedules.',
    read: ['get_note', 'list_note_attachments', 'list_notes', 'list_schedule_targets', 'preview_note_schedule'],
    write: [
      'add_note_attachment',
      'create_note',
      'delete_note',
      'delete_note_with_undo',
      'remove_note_attachment',
      'remove_note_schedule',
      'run_note_now',
      'schedule_note',
      'set_note_lock',
      'set_note_schedule',
      'set_note_visibility',
      'undo_note_delete',
      'update_note'
    ]
  },
  {
    name: 'files',
    title: 'Files',
    description: 'Read lists and previews files and transfer status.\nWrite uploads files and prepares or runs file operations.',
    read: ['download_file_chunk', 'get_file_operation', 'get_file_transfer', 'get_files_capabilities', 'list_files', 'preview_file', 'preview_file_object'],
    write: ['begin_file_upload', 'cancel_file_transfer', 'execute_file_operation', 'finalize_file_upload', 'prepare_confirmed_file_operation', 'prepare_file_operation', 'upload_file_chunk']
  },
  {
    name: 'agents',
    title: 'Agents',
    description: 'Read lists agents and their status, history, and available options.\nWrite launches, controls, and sends work to agents.',
    read: [
      'get_agent_latest_response',
      'get_agent_log_tail',
      'get_agent_runtime',
      'get_agent_status',
      'get_launch_options',
      'get_lifecycle_command',
      'list_agent_destinations',
      'list_agent_models',
      'list_agents',
      'list_prompt_history',
      'list_queued_prompts',
      'summarize_agent_response'
    ],
    write: [
      'answer_agent_question',
      'cancel_agent',
      'close_agent',
      'deactivate_agent',
      'launch_agent',
      'launch_scratch_agent',
      'launch_worktree_agent',
      'move_queued_prompt',
      'queue_prompt',
      'queue_prompt_with_attachments',
      'relay_agent_question_answer',
      'remove_queued_prompt',
      'restart_agent',
      'resume_agent',
      'set_agent_model_effort',
      'spawn_agent',
      'steer_agent',
      'update_queued_prompt'
    ]
  },
  {
    name: 'conversations',
    title: 'Conversations',
    description: 'Read lists conversations and transcript entries.\nWrite starts, switches, renames, compacts, or forgets conversations.',
    read: ['get_transcript_item', 'list_conversations', 'list_transcript_items'],
    write: ['compact_conversation', 'forget_conversation', 'new_conversation', 'rename_conversation', 'resume_conversation', 'switch_conversation']
  },
  {
    name: 'worktrees',
    title: 'Worktrees & branches',
    description: 'Read lists worktrees and checks removal status.\nWrite creates, switches, moves, prunes, or removes worktrees and branches.',
    read: ['assess_branch_removal', 'assess_worktree_prune', 'assess_worktree_removal', 'get_worktree_status', 'list_worktrees'],
    write: [
      'create_worktree',
      'execute_branch_removal',
      'execute_worktree_prune',
      'execute_worktree_removal',
      'move_branch',
      'move_pull_request',
      'prepare_branch_removal',
      'prepare_worktree_prune',
      'prepare_worktree_removal',
      'start_new_task',
      'switch_branch',
      'switch_pull_request'
    ]
  },
  {
    name: 'stack',
    title: 'Stack',
    description: 'Read gets stack status and logs.\nWrite runs configured stack actions.',
    read: ['get_process_log', 'get_stack_log', 'get_stack_status'],
    write: ['run_stack_action']
  },
  {
    name: 'reviews',
    title: 'Reviews & comparisons',
    description: 'Read gets review and comparison results and options.\nWrite starts, updates, asks about, or cancels reviews and comparisons.',
    read: ['get_ask_job', 'get_comparison', 'get_comparison_file', 'get_review_job', 'get_review_status', 'get_stored_review', 'list_comparison_commits', 'list_merge_bases', 'list_review_options'],
    write: ['ask_comparison', 'ask_review', 'cancel_review_job', 'set_merge_base', 'start_code_review', 'start_review', 'start_review_tour']
  },
  {
    name: 'github',
    title: 'GitHub',
    description: 'Read gets pull request status and discussion.\nWrite creates pull requests and manages review threads and requests.',
    read: ['get_github_overview', 'get_github_pull_request', 'get_pull_request_draft', 'get_pull_request_status'],
    write: ['create_pull_request', 'create_pull_request_review_draft', 'reply_github_thread', 'rerequest_github_review', 'resolve_github_thread']
  },
  {
    name: 'actions',
    title: 'Configured actions',
    description: 'Read lists configured actions and their status.\nWrite invokes configured actions.',
    read: ['get_configured_action_status', 'list_configured_actions', 'resolve_configured_action'],
    write: ['invoke_configured_action']
  },
  {
    name: 'watches',
    title: 'Watches',
    description: 'Read lists watches and their events.\nWrite creates, acknowledges, or removes watches.',
    read: ['get_watch_events', 'list_watches'],
    write: ['ack_watch_events', 'unwatch', 'watch_command', 'watch_process', 'watch_pull_request', 'watch_review_requests']
  },
  {
    name: 'workspace',
    title: 'Workspace status',
    description: 'Read lists instances and summarizes workspace and attention status.',
    read: ['list_instances', 'summarize_attention_items', 'summarize_workspace'],
    write: []
  },
  {
    name: 'davo',
    title: 'Davo delegation',
    description: 'Write answers Davo choices, binds a target, and delegates the admitted request.',
    read: [],
    write: ['answer_davo_choice', 'bind_davo_target', 'delegate_request']
  }
] as const satisfies readonly McpPermissionGroup[];
