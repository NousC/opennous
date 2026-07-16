import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

interface AdminRouteProps {
  children: React.ReactNode;
}

export function AdminRoute({ children }: AdminRouteProps) {
  const { userData, loading } = useAuth();
  const navigate = useNavigate();

  // Check if user is admin from userData (comes from /me endpoint)
  // userData structure: { user: { id, email, is_admin, ... }, ... }
  const isAdmin = userData?.user?.is_admin === true;

  useEffect(() => {
    if (!loading && !isAdmin) {
      navigate("/");
    }
  }, [loading, isAdmin, navigate, userData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-muted-foreground">Checking permissions...</div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="text-muted-foreground mb-2">Access Denied</div>
          <div className="text-sm text-muted-foreground">Admin access required</div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

