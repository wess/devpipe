#
#  attachments.ex
#  lib
# 
#  Created by Wess Cope (me@wess.io) on 12/13/19
#  Copyright 2019 Wess Cope
#

defmodule Attachments do
  require Logger
  use Router

  alias Attachment.Provider, as: Provider

  plug :match
  plug :dispatch

  get "/:identifier" do
    case Provider.get(identifier: conn.params["identifier"]) do
      nil ->
        conn
        |> json(404, %{error: "File #{identifier} not found"})
      attachment ->
        conn
        |> json(200, attachment)
    end
  end

  get "/search" do #owner=xyz&name=bl
    owner_id  = conn.query_params["owner"]
    name      = conn.query_params["name"]

    conn
    |> json(200, Provider.search(owner_id, name))
  end

  get "/static/:identifier" do
    conn
    |> get_file(conn.params["identifier"])
  end

  get "/download/:identifier" do
    conn
    |> download_file(conn.params["identifier"])
  end

  post "/" do
    case create_upload(conn.params) do
      {:error, errors} ->
        conn
        |> json(400, errors)
      {:ok, uploaded} ->
        conn
        |> json(200, uploaded)
    end
  end

  ### Private
  defp get_file(conn, identifier) do
    case Provider.get(identifier: identifier) do
      nil -> 
        conn
        |> json(404, %{error: "File #{identifier} not found"})
      upload ->
        Logger.info(fn-> "#{inspect upload}" end)
        
        conn
        |> file("priv/buckets/uploads/#{upload.attachment[:file_name]}")
    end
  end

  defp download_file(conn, identifier) do
    case Provider.get(identifier: identifier) do
      nil -> 
        conn
        |> json(404, %{error: "File #{identifier} not found"})
      upload ->
        conn
        |> download("priv/buckets/uploads/#{upload.attachment[:file_name]}")
    end
  end


  defp create_upload(params) do
    Logger.info(fn-> "Params: #{inspect params}" end)

    case Provider.create(changeset_params(params)) do
      {:error, changeset} -> 
        {:error, parse_errors(changeset)}
      {:ok, uploaded} ->
        {:ok, uploaded}
    end
  end

end
