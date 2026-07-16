import { motion } from "framer-motion";
import { ContactDocumentsTab } from "./ContactDocumentsTab";

interface ContactDetailTabsProps {
  contactId: string;
  workspaceId: string;
}

const fadeInUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
};

export function ContactDetailTabs({ contactId, workspaceId }: ContactDetailTabsProps) {
  return (
    <div className="h-full overflow-hidden flex flex-col">
      <motion.div
        className="flex-1 min-h-0 bg-white border-0 rounded-2xl shadow-sm overflow-hidden flex flex-col"
        variants={fadeInUp}
        initial="initial"
        animate="animate"
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="px-4 py-2 border-b border-gray-100 flex-shrink-0">
          <h3 className="text-[13px] font-semibold text-gray-900">Documents</h3>
        </div>
        <div className="flex-1 min-h-0 overflow-auto scrollbar-hide">
          <ContactDocumentsTab contactId={contactId} />
        </div>
      </motion.div>
    </div>
  );
}
