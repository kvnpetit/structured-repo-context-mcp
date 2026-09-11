<?php
final class ReportController
{
    public function generateAuditReport(string $projectId): string
    {
        return "audit:" . $projectId;
    }
}
