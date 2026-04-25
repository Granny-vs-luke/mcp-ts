"use client";

import { useEffect, useState } from "react";
import { type McpClient } from "@mcp-ts/sdk/client/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ElicitationDialogProps {
  mcpClient: McpClient | null | undefined;
}

export default function ElicitationDialog({ mcpClient }: ElicitationDialogProps) {
  const request = mcpClient?.elicitationRequests?.[0];
  const [formData, setFormData] = useState<Record<string, any>>({});

  // Reset form when request changes
  useEffect(() => {
    setFormData({});
  }, [request?.elicitationId]);

  if (!request) return null;

  const handleAction = (action: "accept" | "decline" | "cancel") => {
    mcpClient?.respondToElicitation(request.elicitationId, action, action === "accept" ? formData : undefined);
  };

  const schema = request.schema as any;
  const properties = schema?.properties || {};
  const required = schema?.required || [];

  return (
    <Dialog open={!!request} onOpenChange={(open) => { if (!open) handleAction("cancel"); }}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Action Required</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap">{request.message}</DialogDescription>
        </DialogHeader>

        {request.mode === "form" && (
          <div className="grid gap-4 py-4">
            {Object.entries(properties).map(([key, prop]: [string, any]) => {
              const isRequired = required.includes(key);
              
              if (prop.type === "boolean") {
                return (
                  <div key={key} className="flex flex-row items-center space-x-2">
                    <input
                      type="checkbox"
                      id={key}
                      className="size-4 rounded border-gray-300"
                      checked={!!formData[key]}
                      onChange={(e) => setFormData(prev => ({ ...prev, [key]: e.target.checked }))}
                    />
                    <label htmlFor={key} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                      {prop.title || key} {isRequired && "*"}
                    </label>
                  </div>
                );
              }

              if (prop.enum) {
                return (
                  <div key={key} className="grid gap-2">
                    <label htmlFor={key} className="text-sm font-medium leading-none">
                      {prop.title || key} {isRequired && "*"}
                    </label>
                    <Select
                      value={formData[key] || ""}
                      onValueChange={(val) => setFormData(prev => ({ ...prev, [key]: val }))}
                    >
                      <SelectTrigger id={key}>
                        <SelectValue placeholder="Select an option" />
                      </SelectTrigger>
                      <SelectContent>
                        {prop.enum.map((opt: string) => (
                          <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              }

              return (
                <div key={key} className="grid gap-2">
                  <label htmlFor={key} className="text-sm font-medium leading-none">
                    {prop.title || key} {isRequired && "*"}
                  </label>
                  <Input
                    id={key}
                    type={prop.type === "number" ? "number" : "text"}
                    value={formData[key] || ""}
                    onChange={(e) => setFormData(prev => ({ 
                      ...prev, 
                      [key]: prop.type === "number" ? Number(e.target.value) : e.target.value 
                    }))}
                  />
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter className="flex-row sm:justify-end gap-2 mt-4">
          <Button variant="outline" onClick={() => handleAction("decline")}>
            Decline
          </Button>
          {request.mode === "form" ? (
            <Button onClick={() => handleAction("accept")}>
              Submit
            </Button>
          ) : (
            <Button onClick={() => {
              if (request.url) window.open(request.url, "_blank");
              handleAction("accept");
            }}>
              Authorize
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
