// Accounts — the list of everyone we're in touch with, and a way into any one record.
//
// Opening a person is a real navigation: clicking a row goes to /contacts/:id, exactly the
// way clicking a company goes to /companies/:id. That's what makes the workspace tab bar
// behave — Back returns here, and every record you open is a real, persistent tab.
//
// The deal board is its own page now (/pipeline), and the relationship graph is a global
// shortcut on the tab bar (top-right of every page), so neither lives here anymore.
import { useNavigate } from "react-router-dom";
import People from "./People";

export default function Accounts() {
  const navigate = useNavigate();
  const openPerson = (id: string) => { if (id) navigate(`/contacts/${id}`); };

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      <People embedded onOpen={c => openPerson(c.id)} />
    </div>
  );
}
