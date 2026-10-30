// Living files (GET-1039, GET-1044), what the Context sidebar's tree and the explorer share. The files
// OpenNous keeps current; the API's /api/context/living-files. The gallery that lived here went with
// Settings > Knowledge (GET-1082).

// GET-1055: how far behind an enabled file is: items newer than the last one it read, cited items
// since retired, and the points resting on them. null when the API could not read it.
type Behind = { new: number; retracted: number; points: number };
export type LivingFile = { key: string; title: string; about: string; enabled: boolean; file_id: string | null; last_run_at?: string | null; last_error?: string | null; behind?: Behind | null };

// The Workflows list's switch, so an on/off reads the same in both places.
export const SWITCH = 'h-[18px] w-[30px] border-0 data-[state=unchecked]:bg-border [&>span]:size-3.5 [&>span]:translate-x-0.5 [&>span]:shadow-[0_1px_2px_rgba(0,0,0,.2)] [&>span]:data-[state=checked]:translate-x-[14px]';
