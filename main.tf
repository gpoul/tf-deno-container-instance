terraform {
  required_version = ">= 1.5.0"

  required_providers {
    oci = {
      source = "oracle/oci"
    }
    time = {
      source = "hashicorp/time"
    }
  }
}

provider "oci" {
  region = var.region
}

variable "tenancy_ocid" {
  description = "The OCID of the tenancy."
  type        = string
}

variable "compartment_ocid" {
  description = "The OCID of the compartment where resources will be created."
  type        = string
}

variable "nosql_compartment_ocid" {
  description = "The OCID of the compartment containing the NoSQL table. Defaults to compartment_ocid when unset."
  type        = string
  default     = null
}

variable "region" {
  description = "OCI region identifier, for example eu-frankfurt-1."
  type        = string
}

variable "availability_domain_index" {
  description = "Zero-based availability domain index for the container instance."
  type        = number
  default     = 0
}

variable "container_instance_name" {
  description = "Display name for the OCI Container Instance."
  type        = string
}

variable "container_image_url" {
  description = "Required public GHCR image URL for the container image."
  type        = string
}

variable "fqdn" {
  description = "Optional fully qualified domain name to point at the container instance. When unset, no DNS zone lookup or DNS record is created."
  type        = string
  default     = null
}

locals {
  fqdn_input                        = try(trimspace(var.fqdn), "")
  fqdn                              = local.fqdn_input == "" ? null : trimsuffix(local.fqdn_input, ".")
  fqdn_parts                        = local.fqdn == null ? [] : split(".", local.fqdn)
  target_zone                       = local.fqdn == null ? null : "${join(".", slice(local.fqdn_parts, 1, length(local.fqdn_parts)))}."
  nosql_compartment_ocid            = coalesce(var.nosql_compartment_ocid, var.compartment_ocid)
}

resource "oci_core_vcn" "dinosaurs_vcn" {
  compartment_id = var.compartment_ocid
  cidr_block     = "10.0.0.0/16"
  display_name   = "dinosaurs-vcn"
  dns_label      = "dinosaursvcn"
}

resource "oci_core_internet_gateway" "dinosaurs_igw" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.dinosaurs_vcn.id
  display_name   = "dinosaurs-igw"
}

resource "oci_core_route_table" "dinosaurs_route_table" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.dinosaurs_vcn.id
  display_name   = "dinosaurs-route-table"

  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.dinosaurs_igw.id
  }
}

resource "oci_core_security_list" "dinosaurs_security_list" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.dinosaurs_vcn.id
  display_name   = "dinosaurs-security-list"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
    stateless   = false
  }

  ingress_security_rules {
    protocol  = "6"
    source    = "0.0.0.0/0"
    stateless = false

    tcp_options {
      min = 8000
      max = 8000
    }
  }

  ingress_security_rules {
    protocol  = "6"
    source    = "0.0.0.0/0"
    stateless = false

    tcp_options {
      min = 443
      max = 443
    }
  }
}

resource "oci_core_subnet" "dinosaurs_subnet" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.dinosaurs_vcn.id
  cidr_block                 = "10.0.0.0/24"
  display_name               = "dinosaurs-subnet"
  dns_label                  = "dinosaurssubnet"
  route_table_id             = oci_core_route_table.dinosaurs_route_table.id
  security_list_ids          = [oci_core_security_list.dinosaurs_security_list.id]
  prohibit_public_ip_on_vnic = false
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

resource "oci_identity_policy" "dinosaurs_nosql" {
  compartment_id = var.nosql_compartment_ocid
  name           = "dinosaurs-nosql-access"
  description    = "Allow the container instance to access the dinosaurs NoSQL table."

  statements = [
    "Allow any-user to read nosql-tables in compartment id ${local.nosql_compartment_ocid} where all {request.principal.type='computecontainerinstance', request.principal.id='${oci_container_instances_container_instance.dinosaurs.id}'}",
    "Allow any-user to manage nosql-rows in compartment id ${local.nosql_compartment_ocid} where all {request.principal.type='computecontainerinstance', request.principal.id='${oci_container_instances_container_instance.dinosaurs.id}'}",
  ]
}

resource "time_sleep" "wait_for_network" {
  depends_on = [
    oci_core_subnet.dinosaurs_subnet,
    oci_core_internet_gateway.dinosaurs_igw
  ]

  create_duration = "60s"
}

resource "oci_container_instances_container_instance" "dinosaurs" {
  depends_on = [time_sleep.wait_for_network]

  availability_domain      = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  compartment_id           = var.compartment_ocid
  display_name             = var.container_instance_name
  container_restart_policy = "ALWAYS"
  shape                    = "CI.Standard.E4.Flex"
  state                    = "ACTIVE"

  shape_config {
    memory_in_gbs = 2
    ocpus         = 1
  }

  containers {
    display_name = "dinosaurs"
    image_url    = var.container_image_url

    health_checks {
      health_check_type        = "HTTP"
      path                     = "/api/OCI"
      port                     = 8000
      interval_in_seconds      = 30
      timeout_in_seconds       = 5
      success_threshold        = 1
      failure_threshold        = 3
      initial_delay_in_seconds = 10
    }

    resource_config {
      memory_limit_in_gbs = 1
      vcpus_limit         = 1
    }

    environment_variables = {
      NOSQL_TABLE_NAME             = "dinosaurs"
      NOSQL_COMPARTMENT_OCID       = local.nosql_compartment_ocid
      NOSQL_USE_RESOURCE_PRINCIPAL = true
    }
  }

  vnics {
    subnet_id             = oci_core_subnet.dinosaurs_subnet.id
    display_name          = "dinosaurs-vnic"
    hostname_label        = "dinosaurs"
    is_public_ip_assigned = true
  }
}

data "oci_dns_zone" "target_zone" {
  count           = local.fqdn == null ? 0 : 1
  zone_name_or_id = local.target_zone
  scope           = "GLOBAL"
}

resource "oci_dns_rrset" "a-records" {
  count           = local.fqdn == null ? 0 : 1
  domain          = local.fqdn
  rtype           = "A"
  zone_name_or_id = data.oci_dns_zone.target_zone[0].id

  items {
    domain = local.fqdn
    rdata  = data.oci_core_vnic.dinosaurs_vnic.public_ip_address
    rtype  = "A"
    ttl    = 60
  }
}

data "oci_core_vnic" "dinosaurs_vnic" {
  vnic_id = oci_container_instances_container_instance.dinosaurs.vnics[0].vnic_id
}

output "container_instance_id" {
  description = "The OCID of the container instance."
  value       = oci_container_instances_container_instance.dinosaurs.id
}

output "container_instance_public_ip" {
  description = "The public IP address assigned to the container instance VNIC."
  value       = data.oci_core_vnic.dinosaurs_vnic.public_ip_address
}

output "dinosaursUrl" {
  value = "http://${coalesce(local.fqdn, data.oci_core_vnic.dinosaurs_vnic.public_ip_address)}:8000"
}
